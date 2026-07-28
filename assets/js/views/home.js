// 首页视图：全局统计 + 分组服务器卡片（进度条 / 圆环 / 表格三种模式）
// 数据来源：GET /api/servers；实时更新：/api/ws (subscribe=all)

import {
  avgPing,
  billingText,
  daysUntil,
  debounce,
  el,
  flagEmoji,
  fmtBytes,
  fmtClock,
  fmtMB,
  fmtSpeed,
  fmtUptime,
  icon,
  isOnline,
  num,
  osName,
  parseTrafficLimit,
  pct,
  pingClass,
  pingState,
  priceText,
  shortOS,
  stateBlock,
  svg,
  timeAgo,
} from '../utils.js';
import {getServers} from '../api.js';
import {Playback, normalizeTs} from '../playback.js';
import {MetricSocket} from '../ws.js';

const MODE_LABELS = { bar: '进度条', ring: '圆环', table: '表格' };

function levelClass(p) {
  if (p == null) return '';
  return p >= 90 ? ' lv-bad' : p >= 70 ? ' lv-warn' : '';
}

/** 字节数 → 整数 + 单字母单位（600G / 1T），用于流量包 chip */
function fmtLimitInt(bytes) {
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${Math.round(v)}${units[i]}`;
}

function arrowIcon(dir) {
  // 两个箭头在画布里垂直居中对称（5..19），并排时不会一高一低
  const d =
    dir === 'down' ? 'M12 5v14m0 0-5-5m5 5 5-5' : 'M12 19V5m0 0-5 5m5-5 5 5';
  return svg(
    'svg',
    {
      viewBox: '0 0 24 24',
      class: `ico ${dir === 'down' ? 'ico-down' : 'ico-up'}`,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2.2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    svg('path', { d }),
  );
}

// ---------- 进度条卡片 ----------

function meterRow(label) {
  const fill = el('i', { class: 'meter-fill' });
  const val = el('span', { class: 'meter-val mono', text: '—' });
  const row = el(
    'div',
    { class: 'meter-row' },
    el('div', { class: 'meter-top' }, el('span', { class: 'meter-label', text: label }), val),
    el('div', { class: 'meter-bar' }, fill),
  );
  return {
    el: row,
    set(p, text) {
      fill.style.width = `${p == null ? 0 : Math.min(100, p)}%`;
      fill.className = `meter-fill${levelClass(p)}`;
      val.textContent = text != null ? text : p == null ? '—' : `${p.toFixed(0)}%`;
    },
  };
}

// 实时时间行（对齐官方 dataTimeText）
// 上报：仅时钟（官方不给 report 加 lag）
// 采集：时钟 + (+Ns)，lag = display_ts - sample_ts；display_ts 为展示时钟，
// 在线时随 wall clock 每秒前进，(+Ns) 随之增长，下一个样本应用时回落
// 返回 [上报文本, 采集文本, lag 文本]；单条上报时上报为 null，采集位放合并文本；
// lag 文本独立返回，便于用固定宽度占位（避免位数变化导致布局抖动）
function liveParts(d) {
  if (!isOnline(d) || !d.sample_ts) return null;
  if (!d.report_ts || d.batch_size === 1) {
    // 单条上报：展示时钟（≈上报时刻）− 采集时刻
    const t = d.display_ts || d.report_ts || d.sample_ts;
    const lag = Math.max(0, Math.floor((t - d.sample_ts) / 1000));
    return [null, `上报 ${fmtClock(d.sample_ts)}`, lag > 0 ? `(+${lag}s)` : ''];
  }
  // 批量上报：上报仅时钟，采集带 lag
  const lag = d.display_ts
    ? Math.max(0, Math.floor((d.display_ts - d.sample_ts) / 1000))
    : 0;
  return [`上报 ${fmtClock(d.report_ts)}`, `采集 ${fmtClock(d.sample_ts)}`, lag > 0 ? `(+${lag}s)` : ''];
}

function fillLive(node, d) {
  node.textContent = '';
  const parts = liveParts(d);
  if (parts) {
    node.append(el('div', { class: 'live-row', text: parts.filter(Boolean).join(' · ') }));
    node.style.visibility = 'visible';
  } else {
    node.style.visibility = 'hidden';
  }
}

// meta 行：单行 marquee——内容超出时克隆一份，整体左移 -50% 无缝循环
function marqueeRow(items) {
  const clone = el('span', { class: 'mq-inner', 'aria-hidden': 'true' });
  clone.style.display = 'none';
  const inner = el('span', { class: 'mq-inner' }, ...items);
  const track = el('span', { class: 'mq-track' }, inner, clone);
  const row = el('div', { class: 'mq-row' }, track);
  return {
    el: row,
    fit() {
      if (!row.clientWidth) return; // 未入 DOM / 隐藏时跳过，下个 tick 再测
      const need = inner.scrollWidth > row.clientWidth;
      row.classList.toggle('marquee', need);
      clone.style.display = need ? '' : 'none';
      if (need) {
        clone.innerHTML = inner.innerHTML;
        track.style.animationDuration = `${Math.max(6, inner.scrollWidth / 40)}s`;
      }
    },
  };
}

// 卡片底部行三项：[在线 时长] [上报] [采集(+Ns)]（左中右）
// lag 独立 span 固定占位，(+Ns) 出现/消失/位数变化都不会推动布局；
// 离线时采集项 visibility 隐藏（保留占位），上报项 display 隐藏
function setLive(repEl, smpWrap, smpText, lagEl, d) {
  const parts = liveParts(d);
  repEl.textContent = parts && parts[0] ? parts[0] : '';
  repEl.style.display = parts && parts[0] ? '' : 'none';
  const has = !!(parts && parts[1]);
  smpText.nodeValue = has ? parts[1] : '';
  lagEl.textContent = has ? parts[2] : '';
  smpWrap.style.visibility = has ? '' : 'hidden';
}

// 负载显示：1m/5m/15m 三个值 + 按核心数颜色分级
function loadDisplay() {
  const spans = Array.from({ length: 3 }, () => el('span', { class: 'ld-val mono', text: '—' }));
  const box = el('span', { class: 'load-box' }, spans);
  return {
    el: box,
    update(d) {
      const parts = String(d.load_avg || '').trim().split(/\s+/).map(Number);
      const cores = num(d.cpu_cores) || 0;
      for (let i = 0; i < 3; i += 1) {
        const v = Number.isFinite(parts[i]) ? parts[i] : null;
        spans[i].textContent = v == null ? '—' : v.toFixed(2);
        // 按 load/cores 比值分级：<0.7 绿 / <1.0 黄 / ≥1.0 红
        let cls = '';
        if (v != null && cores > 0) {
          const ratio = v / cores;
          cls = ratio >= 1.0 ? 'bad' : ratio >= 0.7 ? 'mid' : 'good';
        } else if (v != null) {
          cls = v >= 2 ? 'bad' : v >= 1 ? 'mid' : 'good';
        }
        spans[i].className = `ld-val mono${cls ? ` ${cls}` : ''}`;
      }
    },
  };
}

// Ping 分项（对齐官方 ping-panel）
const PING_CARRIERS = [
  { key: 'ct', label: '电信' },
  { key: 'cu', label: '联通' },
  { key: 'cm', label: '移动' },
  { key: 'bd', label: 'BGP' },
];

function pingPanel() {
  const items = PING_CARRIERS.map((c) => {
    const val = el('span', { class: 'pp-val mono', text: '—' });
    const item = el('span', { class: 'pp-item' },
      el('span', { class: 'pp-label', text: c.label }),
      val,
    );
    return { ...c, val, item };
  });
  const panel = el('div', { class: 'ping-panel' }, items.map((p) => p.item));
  panel.style.display = 'none';
  return {
    el: panel,
    update(d) {
      let has = false;
      for (const p of items) {
        const pv = pingState(d[`ping_${p.key}`]);
        if (pv.kind === 'disabled') { p.item.style.display = 'none'; continue; }
        p.item.style.display = '';
        if (pv.kind === 'ok') {
          p.val.textContent = `${pv.value.toFixed(0)}ms`;
          p.val.className = `pp-val mono ${pingClass(pv.value)}`;
        } else {
          p.val.textContent = '—';
          p.val.className = 'pp-val mono';
        }
        has = true;
      }
      panel.style.display = has ? '' : 'none';
    },
  };
}

function ipBadges() {
  const box = el('span', { class: 'tag-box' });
  return {
    el: box,
    update(d) {
      box.textContent = '';
      let n = 0;
      if (String(d.ip_v4) === '1') {
        box.append(el('span', { class: 'tag-chip ip-chip', text: 'IPv4' }));
        n += 1;
      }
      if (String(d.ip_v6) === '1') {
        box.append(el('span', { class: 'tag-chip ip-chip', text: 'IPv6' }));
        n += 1;
      }
      box.style.display = n ? '' : 'none';
    },
  };
}

function barCard(s, sysConfig) {
  const dot = el('i', { class: 'status-dot' });
  const name = el('h3', { class: 'srv-name' });
  const region = el('span', { class: 'tag-chip region-chip' });
  const osChip = el('span', { class: 'tag-chip' });
  const tagsBox = el('span', { class: 'tag-box' });
  const ips = ipBadges();
  const priceChip = el('span', { class: 'tag-chip' });
  const expChip = el('span', { class: 'tag-chip' });
  const tfDown = arrowIcon('down');
  const tfUp = arrowIcon('up');
  const tfText = document.createTextNode('');
  const tfChip = el('span', { class: 'tag-chip tf-chip' }, tfDown, tfUp, tfText);
  // meta 两行：地区/系统/标签/IP 一行，价格/到期/流量包一行；每行溢出各自独立滚动
  const meta1 = marqueeRow([region, osChip, tagsBox, ips.el]);
  const meta2 = marqueeRow([priceChip, expChip, tfChip]);
  const subRow = el('div', { class: 'srv-sub' }, meta1.el, meta2.el);
  const lastSeen = el('span', { class: 'last-seen dim' });
  const cpu = meterRow('CPU');
  const ram = meterRow('内存');
  const disk = meterRow('磁盘');
  const load = loadDisplay();
  const upLabel = document.createTextNode('在线 ');
  const upText = document.createTextNode('—');
  const up = el('span', { class: 'bt-item mono' }, upLabel, upText);
  const downV = el('b', { class: 'mono' });
  const upV = el('b', { class: 'mono' });
  const trfDownV = el('b', { class: 'mono' });
  const trfUpV = el('b', { class: 'mono' });
  const pings = pingPanel();
  const liveRep = el('span', { class: 'bt-item mono' });
  const liveSmpText = document.createTextNode('');
  const liveLag = el('span', { class: 'bt-lag' });
  const liveSmp = el('span', { class: 'bt-item mono' }, liveSmpText, liveLag);

  const card = el(
    'article',
    { class: 'srv-card', tabindex: '0', role: 'link' },
    el(
      'div',
      { class: 'srv-head' },
      dot,
      el('div', { class: 'srv-title' }, name),
      lastSeen,
    ),
    subRow,
    el('div', { class: 'srv-meters' }, cpu.el, ram.el, disk.el),
    el(
      'div',
      { class: 'srv-info' },
      el(
        'div',
        { class: 'info-row' },
        el('span', { class: 'info-label', text: '负载' }),
        load.el,
      ),
      el(
        'div',
        { class: 'info-row' },
        el('span', { class: 'info-label', text: '网络' }),
        el('span', { class: 'net-item' }, arrowIcon('down'), downV),
        el('span', { class: 'net-item' }, arrowIcon('up'), upV),
      ),
      el(
        'div',
        { class: 'info-row' },
        el('span', { class: 'info-label', text: '流量' }),
        el('span', { class: 'net-item' }, arrowIcon('down'), trfDownV),
        el('span', { class: 'net-item' }, arrowIcon('up'), trfUpV),
      ),
    ),
    pings.el,
    el('div', { class: 'srv-bottom' }, up, liveRep, liveSmp),
  );

  const go = () => {
    location.hash = `#/server/${encodeURIComponent(s.id)}`;
  };
  card.addEventListener('click', go);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });

  function render(d) {
    const online = isOnline(d);
    card.classList.toggle('is-off', !online);
    dot.className = `status-dot ${online ? 'on' : 'off'}`;
    name.textContent = d.name || '未命名';

    const flag = flagEmoji(d.region);
    region.textContent = flag ? `${flag} ${d.region}` : d.region || '';
    region.style.display = d.region ? '' : 'none';
    const osn = osName(d.os);
    osChip.textContent = osn;
    osChip.title = d.os || '';
    osChip.style.display = osn ? '' : 'none';
    // 价格 / 到期（站点开关控制；到期 ≤7 天变黄、已过期变红）
    const pr = sysConfig.show_price ? priceText(d.price, d.currency) : null;
    priceChip.textContent = pr ? (pr === '免费' ? pr : `${pr}/${billingText(d.billing_cycle)}`) : '';
    priceChip.style.display = pr ? '' : 'none';
    const days = sysConfig.show_expire && d.expire_date ? daysUntil(d.expire_date) : null;
    if (days != null) {
      expChip.textContent = days < 0 ? '已过期' : `${days}天`;
      expChip.className = `tag-chip${days < 0 ? ' bad' : days <= 7 ? ' warn' : ''}`;
      expChip.style.display = '';
    } else {
      expChip.style.display = 'none';
    }
// 流量包（站点开关 + 服务器设限）：按计费方向显示箭头 + 整数总量(剩余占比)
    const tfLimit = sysConfig.show_tf ? parseTrafficLimit(d.traffic_limit) : null;
    if (tfLimit) {
      const mRx = num(d.net_rx_monthly) || 0;
      const mTx = num(d.net_tx_monthly) || 0;
      const calcType = d.traffic_calc_type || 'total';
      const tfUsed =
        calcType === 'dl' ? mRx
        : calcType === 'ul' ? mTx
        : calcType === 'max' ? Math.max(mRx, mTx)
        : mRx + mTx;
      const remain = Math.max(0, 100 - Math.round((tfUsed / tfLimit) * 100));
      tfDown.style.display = calcType === 'ul' ? 'none' : '';
      tfUp.style.display = calcType === 'dl' ? 'none' : '';
      tfText.textContent = `${fmtLimitInt(tfLimit)}(${remain}%)`;
      tfChip.className = `tag-chip tf-chip${remain <= 0 ? ' bad' : remain <= 20 ? ' warn' : ''}`;
      tfChip.style.display = '';
    } else {
      tfChip.style.display = 'none';
    }
    meta2.el.style.display = pr || days != null || tfLimit ? '' : 'none';

    tagsBox.textContent = '';
    String(d.tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 3)
      .forEach((t) => tagsBox.append(el('span', { class: 'tag-chip', text: t })));
    tagsBox.style.display = tagsBox.childNodes.length ? '' : 'none';
    ips.update(d);

    const cpuV = num(d.cpu);
    cpu.set(cpuV, cpuV == null ? '—' : `${cpuV.toFixed(1)}%`);
    const rp = pct(d.ram_used, d.ram_total);
    ram.set(rp, rp == null ? '—' : `${fmtMB(d.ram_used)} / ${fmtMB(d.ram_total)}`);
    const dp = pct(d.disk_used, d.disk_total);
    disk.set(dp, dp == null ? '—' : `${fmtMB(d.disk_used)} / ${fmtMB(d.disk_total)}`);

    // 负载
    load.update(d);

    downV.textContent = fmtSpeed(d.net_in_speed);
    upV.textContent = fmtSpeed(d.net_out_speed);
    trfDownV.textContent = fmtBytes(num(d.net_rx_monthly) || 0);
    trfUpV.textContent = fmtBytes(num(d.net_tx_monthly) || 0);

    upLabel.textContent = online ? '在线 ' : '离线 ';
    upText.textContent = fmtUptime(d.boot_time);
    lastSeen.textContent = online ? '' : timeAgo(d.last_updated);

    pings.update(d);
    setLive(liveRep, liveSmp, liveSmpText, liveLag, d);
    meta1.fit();
    meta2.fit();
  }

  render(s);
  return { el: card, update: render };
}

// ---------- 圆环卡片 ----------

function ringGauge() {
  const R = 30;
  const C = 2 * Math.PI * R;
  const val = svg('circle', {
    cx: '37',
    cy: '37',
    r: String(R),
    class: 'ring-val',
    'stroke-dasharray': C.toFixed(1),
    'stroke-dashoffset': C.toFixed(1),
  });
  const txt = svg('text', { x: '37', y: '41.5', 'text-anchor': 'middle', class: 'ring-txt mono' }, '—');
  const node = svg(
    'svg',
    { viewBox: '0 0 74 74', class: 'ring-svg' },
    svg('circle', { cx: '37', cy: '37', r: String(R), class: 'ring-track' }),
    val,
    txt,
  );
  return {
    el: node,
    set(p) {
      const v = p == null ? 0 : Math.min(100, Math.max(0, p));
      val.setAttribute('stroke-dashoffset', (C * (1 - v / 100)).toFixed(1));
      val.setAttribute('class', `ring-val${levelClass(p)}`);
      txt.textContent = p == null ? '—' : `${p.toFixed(0)}%`;
    },
  };
}

function ringCard(s, sysConfig) {
  const dot = el('i', { class: 'status-dot' });
  const name = el('h3', { class: 'srv-name' });
  const region = el('span', { class: 'tag-chip region-chip' });
  const osChip = el('span', { class: 'tag-chip' });
  const tagsBox = el('span', { class: 'tag-box' });
  const ips = ipBadges();
  const priceChip = el('span', { class: 'tag-chip' });
  const expChip = el('span', { class: 'tag-chip' });
  const tfDown = arrowIcon('down');
  const tfUp = arrowIcon('up');
  const tfText = document.createTextNode('');
  const tfChip = el('span', { class: 'tag-chip tf-chip' }, tfDown, tfUp, tfText);
  // meta 两行：地区/系统/标签/IP 一行，价格/到期/流量包一行；每行溢出各自独立滚动
  const meta1 = marqueeRow([region, osChip, tagsBox, ips.el]);
  const meta2 = marqueeRow([priceChip, expChip, tfChip]);
  const subRow = el('div', { class: 'srv-sub' }, meta1.el, meta2.el);
  const lastSeen = el('span', { class: 'last-seen dim' });
  const cpu = ringGauge();
  const ram = ringGauge();
  const disk = ringGauge();
  const load = loadDisplay();
  const upLabel = document.createTextNode('在线 ');
  const upText = document.createTextNode('—');
  const up = el('span', { class: 'bt-item mono' }, upLabel, upText);
  const downV = el('b', { class: 'mono' });
  const upV = el('b', { class: 'mono' });
  const trfDownV = el('b', { class: 'mono' });
  const trfUpV = el('b', { class: 'mono' });
  const pings = pingPanel();
  const liveRep = el('span', { class: 'bt-item mono' });
  const liveSmpText = document.createTextNode('');
  const liveLag = el('span', { class: 'bt-lag' });
  const liveSmp = el('span', { class: 'bt-item mono' }, liveSmpText, liveLag);

  const card = el(
    'article',
    { class: 'srv-card', tabindex: '0', role: 'link' },
    el(
      'div',
      { class: 'srv-head' },
      dot,
      el('div', { class: 'srv-title' }, name),
      lastSeen,
    ),
    subRow,
    el(
      'div',
      { class: 'ring-row' },
      el('div', { class: 'ring-item' }, cpu.el, el('span', { class: 'ring-label', text: 'CPU' })),
      el('div', { class: 'ring-item' }, ram.el, el('span', { class: 'ring-label', text: '内存' })),
      el('div', { class: 'ring-item' }, disk.el, el('span', { class: 'ring-label', text: '磁盘' })),
    ),
    el(
      'div',
      { class: 'srv-info' },
      el(
        'div',
        { class: 'info-row' },
        el('span', { class: 'info-label', text: '负载' }),
        load.el,
      ),
      el(
        'div',
        { class: 'info-row' },
        el('span', { class: 'info-label', text: '网络' }),
        el('span', { class: 'net-item' }, arrowIcon('down'), downV),
        el('span', { class: 'net-item' }, arrowIcon('up'), upV),
      ),
      el(
        'div',
        { class: 'info-row' },
        el('span', { class: 'info-label', text: '流量' }),
        el('span', { class: 'net-item' }, arrowIcon('down'), trfDownV),
        el('span', { class: 'net-item' }, arrowIcon('up'), trfUpV),
      ),
    ),
    pings.el,
    el('div', { class: 'srv-bottom' }, up, liveRep, liveSmp),
  );

  const go = () => {
    location.hash = `#/server/${encodeURIComponent(s.id)}`;
  };
  card.addEventListener('click', go);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });

  function render(d) {
    const online = isOnline(d);
    card.classList.toggle('is-off', !online);
    dot.className = `status-dot ${online ? 'on' : 'off'}`;
    name.textContent = d.name || '未命名';
    const flag = flagEmoji(d.region);
    region.textContent = flag ? `${flag} ${d.region}` : d.region || '';
    region.style.display = d.region ? '' : 'none';
    const osn = osName(d.os);
    osChip.textContent = osn;
    osChip.title = d.os || '';
    osChip.style.display = osn ? '' : 'none';
    // 价格 / 到期（站点开关控制；到期 ≤7 天变黄、已过期变红）
    const pr = sysConfig.show_price ? priceText(d.price, d.currency) : null;
    priceChip.textContent = pr ? (pr === '免费' ? pr : `${pr}/${billingText(d.billing_cycle)}`) : '';
    priceChip.style.display = pr ? '' : 'none';
    const days = sysConfig.show_expire && d.expire_date ? daysUntil(d.expire_date) : null;
    if (days != null) {
      expChip.textContent = days < 0 ? '已过期' : `${days}天`;
      expChip.className = `tag-chip${days < 0 ? ' bad' : days <= 7 ? ' warn' : ''}`;
      expChip.style.display = '';
    } else {
      expChip.style.display = 'none';
    }
// 流量包（站点开关 + 服务器设限）：按计费方向显示箭头 + 整数总量(剩余占比)
    const tfLimit = sysConfig.show_tf ? parseTrafficLimit(d.traffic_limit) : null;
    if (tfLimit) {
      const mRx = num(d.net_rx_monthly) || 0;
      const mTx = num(d.net_tx_monthly) || 0;
      const calcType = d.traffic_calc_type || 'total';
      const tfUsed =
        calcType === 'dl' ? mRx
        : calcType === 'ul' ? mTx
        : calcType === 'max' ? Math.max(mRx, mTx)
        : mRx + mTx;
      const remain = Math.max(0, 100 - Math.round((tfUsed / tfLimit) * 100));
      tfDown.style.display = calcType === 'ul' ? 'none' : '';
      tfUp.style.display = calcType === 'dl' ? 'none' : '';
      tfText.textContent = `${fmtLimitInt(tfLimit)}(${remain}%)`;
      tfChip.className = `tag-chip tf-chip${remain <= 0 ? ' bad' : remain <= 20 ? ' warn' : ''}`;
      tfChip.style.display = '';
    } else {
      tfChip.style.display = 'none';
    }
    meta2.el.style.display = pr || days != null || tfLimit ? '' : 'none';

    tagsBox.textContent = '';
    String(d.tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 3)
      .forEach((t) => tagsBox.append(el('span', { class: 'tag-chip', text: t })));
    tagsBox.style.display = tagsBox.childNodes.length ? '' : 'none';
    ips.update(d);

    cpu.set(num(d.cpu));
    ram.set(pct(d.ram_used, d.ram_total));
    disk.set(pct(d.disk_used, d.disk_total));

    load.update(d);

    downV.textContent = fmtSpeed(d.net_in_speed);
    upV.textContent = fmtSpeed(d.net_out_speed);
    trfDownV.textContent = fmtBytes(num(d.net_rx_monthly) || 0);
    trfUpV.textContent = fmtBytes(num(d.net_tx_monthly) || 0);

    upLabel.textContent = online ? '在线 ' : '离线 ';
    upText.textContent = fmtUptime(d.boot_time);
    lastSeen.textContent = online ? '' : timeAgo(d.last_updated);

    pings.update(d);
    setLive(liveRep, liveSmp, liveSmpText, liveLag, d);
    meta1.fit();
    meta2.fit();
  }

  render(s);
  return { el: card, update: render };
}

// ---------- 表格模式 ----------

function miniCell() {
  const val = el('span', { class: 'mini-val mono', text: '—' });
  const fill = el('i');
  const wrap = el('div', { class: 'mini-cell' }, val, el('div', { class: 'mini-bar' }, fill));
  return {
    el: wrap,
    set(p) {
      val.textContent = p == null ? '—' : `${p.toFixed(0)}%`;
      fill.style.width = `${p == null ? 0 : Math.min(100, p)}%`;
      fill.className = levelClass(p).trim();
    },
  };
}

function tableRow(s) {
  const dot = el('i', { class: 'status-dot' });
  const nameEl = el('span', { text: s.name || '未命名' });
  const osEl = el('span', { class: 't-sub' });
  const regionEl = el('span');
  const cpu = miniCell();
  const ram = miniCell();
  const disk = miniCell();
  const downEl = el('span', { class: 'mono' });
  const upEl = el('span', { class: 'mono' });
  const pingText = document.createTextNode('—');
  const pingEl = el('span', { class: 'ping-chip mono' }, icon('signal'), pingText);
  const uptimeEl = el('span', { class: 't-sub mono' });
  const liveEl = el('div', { class: 't-sub mono' });

  const tr = el(
    'tr',
    { tabindex: '0' },
    el('td', {}, el('div', { class: 't-name' }, dot, el('div', {}, nameEl, el('div', {}, osEl)))),
    el('td', {}, regionEl),
    el('td', {}, cpu.el),
    el('td', {}, ram.el),
    el('td', {}, disk.el),
    el('td', {}, downEl),
    el('td', {}, upEl),
    el('td', {}, pingEl),
    el('td', {}, el('div', {}, uptimeEl, liveEl)),
  );

  const go = () => {
    location.hash = `#/server/${encodeURIComponent(s.id)}`;
  };
  tr.addEventListener('click', go);
  tr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });

  function render(d) {
    const online = isOnline(d);
    tr.classList.toggle('is-off', !online);
    dot.className = `status-dot ${online ? 'on' : 'off'}`;
    nameEl.textContent = d.name || '未命名';
    osEl.textContent = online ? shortOS(d.os) : timeAgo(d.last_updated);
    const flag = flagEmoji(d.region);
    regionEl.textContent = flag ? `${flag} ${d.region}` : d.region || '—';
    cpu.set(num(d.cpu));
    ram.set(pct(d.ram_used, d.ram_total));
    disk.set(pct(d.disk_used, d.disk_total));
    downEl.textContent = fmtSpeed(d.net_in_speed);
    upEl.textContent = fmtSpeed(d.net_out_speed);
    const ap = avgPing(d);
    pingText.textContent = ap == null ? '—' : `${ap.toFixed(0)} ms`;
    pingEl.className = `ping-chip mono${ap == null ? '' : ` ${pingClass(ap)}`}`;
    uptimeEl.textContent = fmtUptime(d.boot_time);
    fillLive(liveEl, d);
  }

  render(s);
  return { el: tr, update: render };
}

function tableCard(list) {
  const tbody = el('tbody');
  const refs = new Map();
  for (const s of list) {
    const r = tableRow(s);
    refs.set(s.id, r);
    tbody.append(r.el);
  }
  const node = el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      { class: 'srv-table' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          ['服务器', '地区', 'CPU', '内存', '磁盘', 'down', 'up', '延迟', '时长'].map((h) =>
            h === 'down' || h === 'up' ? el('th', {}, arrowIcon(h)) : el('th', { text: h }),
          ),
        ),
      ),
      tbody,
    ),
  );
  return { el: node, refs };
}

// ---------- 骨架屏 ----------

function skeletonHome() {
  const box = el('div');
  const sg = el('div', { class: 'stats-grid' });
  for (let i = 0; i < 4; i += 1) sg.append(el('div', { class: 'sk sk-stat' }));
  const grid = el('div', { class: 'cards-grid' });
  for (let i = 0; i < 6; i += 1) grid.append(el('div', { class: 'sk sk-card' }));
  box.append(sg, el('div', { style: { height: '18px' } }), grid);
  return box;
}

// ---------- 主视图 ----------

export async function renderHome(root, ctx) {
  const view = el('div', { class: 'view view-enter' });
  root.append(view);
  view.append(skeletonHome());

  let payload;
  try {
    payload = await getServers();
  } catch (err) {
    view.textContent = '';
    if (err.status === 401) {
      view.append(
        stateBlock({
          icon: 'lock',
          title: '私有站点',
          desc: '该站点未公开访问。探针主题不包含管理端登录入口，请在默认主题中登录后再访问，或联系站长开启公开模式。',
          actionText: '重试',
          onAction: () => ctx.refresh(),
        }),
      );
    } else {
      view.append(
        stateBlock({
          icon: 'err',
          title: '加载失败',
          desc: err.message || '网络错误',
          actionText: '重试',
          onAction: () => ctx.refresh(),
        }),
      );
    }
    return { destroy() {} };
  }

  const servers = payload.servers || [];
  const sysConfig = payload.sysConfig || {};
  // 缓存站点显示开关，详情页合并使用（/api/server 仅返回 show_long_history）
  ctx.sysConfig = sysConfig;
  const dataMap = new Map(servers.map((s) => [s.id, s]));

  const state = {
    mode:
      localStorage.getItem('probe_display_mode') ||
      sysConfig.display_mode ||
      (ctx.config && ctx.config.display_mode) ||
      'bar',
    filter: '',
  };
  if (!MODE_LABELS[state.mode]) state.mode = 'bar';

  // ----- 统计卡片 -----
  const statOnline = { v: el('div', { class: 'stat-value mono' }), s: el('div', { class: 'stat-sub' }) };
  const statDown = { v: el('div', { class: 'stat-value mono' }), s: el('div', { class: 'stat-sub' }) };
  const statUp = { v: el('div', { class: 'stat-value mono' }), s: el('div', { class: 'stat-sub' }) };
  const statMonth = { v: el('div', { class: 'stat-value mono' }), s: el('div', { class: 'stat-sub' }) };

  function statCard(iconNode, label, ref) {
    ref.s.style.display = 'none';
    return el(
      'div',
      { class: 'stat-card' },
      el('div', { class: 'stat-label' }, iconNode, el('span', { text: label })),
      ref.v,
      ref.s,
    );
  }

  const statsGrid = el(
    'section',
    { class: 'stats-grid' },
    statCard(icon('server'), '在线', statOnline),
    statCard(arrowIcon('down'), '下行', statDown),
    statCard(arrowIcon('up'), '上行', statUp),
    statCard(icon('pie'), '月流量', statMonth),
  );

  const regionStats = payload.regionStats || {};
  const regionRow = el(
    'div',
    { class: 'regions-row' },
    Object.entries(regionStats).map(([cc, n]) =>
      el('span', { class: 'region-chip' }, `${flagEmoji(cc) || '🌐'} ${cc} · ${n}`),
    ),
  );
  regionRow.style.display = Object.keys(regionStats).length ? '' : 'none';

  // ----- 工具栏 -----
  const search = el('input', {
    class: 'search-input',
    type: 'search',
    placeholder: '搜索…',
  });
  const segBtns = new Map();
  const seg = el(
    'div',
    { class: 'seg' },
    Object.entries(MODE_LABELS).map(([mode, label]) => {
      const b = el('button', { class: 'seg-btn', text: label, dataset: { mode } });
      b.addEventListener('click', () => {
        if (state.mode === mode) return;
        state.mode = mode;
        try {
          localStorage.setItem('probe_display_mode', mode);
        } catch {
          /* ignore */
        }
        syncSeg();
        renderList();
      });
      segBtns.set(mode, b);
      return b;
    }),
  );

  function syncSeg() {
    for (const [m, b] of segBtns) b.classList.toggle('active', m === state.mode);
  }
  syncSeg();

  const toolbar = el('div', { class: 'toolbar' }, search, seg);

  // ----- 服务器列表 -----
  const groupsBox = el('div', { class: 'groups' });
  let cardRefs = new Map();
  let tableRefs = new Map();

  function groupList() {
    const groups = new Map();
    for (const s of dataMap.values()) {
      const g = s.server_group || 'Default';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    }
    return groups;
  }

  function matchFilter(d) {
    if (!state.filter) return true;
    const hay = `${d.name || ''} ${d.server_group || ''} ${d.tags || ''} ${d.region || ''} ${d.os || ''}`.toLowerCase();
    return hay.includes(state.filter);
  }

  function renderList() {
    cardRefs = new Map();
    tableRefs = new Map();
    groupsBox.textContent = '';
    const groups = groupList();

    if (!groups.size) {
      groupsBox.append(
        stateBlock({ icon: 'empty', title: '暂无服务器', desc: '还没有任何服务器探针上报数据。' }),
      );
      return;
    }

    for (const [g, list] of groups) {
      const grid =
        state.mode === 'table' ? null : el('div', { class: 'cards-grid' });
      const sec = el(
        'section',
        { class: 'group-section', dataset: { group: g } },
        el(
          'header',
          { class: 'group-header' },
          el('h2', { class: 'group-title', text: g }),
          el('span', { class: 'group-count', text: `${list.length} 台` }),
        ),
      );

      if (state.mode === 'table') {
        const t = tableCard(list);
        // 合并各分组的行引用（覆写会导致其他分组丢失实时更新且被过滤逻辑隐藏）
        for (const [k, v] of t.refs) tableRefs.set(k, v);
        sec.append(t.el);
      } else {
        for (const s of list) {
          const c = state.mode === 'ring' ? ringCard(s, sysConfig) : barCard(s, sysConfig);
          cardRefs.set(s.id, c);
          grid.append(c.el);
        }
        sec.append(grid);
      }
      groupsBox.append(sec);
    }
    applyFilter();
  }

  function applyFilter() {
    const sections = groupsBox.querySelectorAll('.group-section');
    let visibleTotal = 0;
    sections.forEach((sec) => {
      let visible = 0;
      const refs = state.mode === 'table' ? tableRefs : cardRefs;
      for (const [sid, ref] of refs) {
        const nodeEl = ref.el;
        if (!sec.contains(nodeEl)) continue;
        const show = matchFilter(dataMap.get(sid));
        nodeEl.style.display = show ? '' : 'none';
        if (show) visible += 1;
      }
      sec.style.display = visible ? '' : 'none';
      visibleTotal += visible;
    });
    let note = groupsBox.querySelector('.filter-empty');
    if (!visibleTotal && dataMap.size) {
      if (!note) {
        note = el('div', { class: 'filter-empty' });
        note.append(stateBlock({ icon: 'empty', title: '没有匹配的服务器', desc: '换个关键词试试。' }));
        groupsBox.append(note);
      }
    } else if (note) {
      note.remove();
    }
  }

  search.addEventListener(
    'input',
    debounce(() => {
      state.filter = search.value.trim().toLowerCase();
      applyFilter();
    }, 120),
  );

  // ----- 统计刷新 -----
  function refreshStats() {
    let online = 0;
    let speedIn = 0;
    let speedOut = 0;
    let monthly = 0;
    for (const s of dataMap.values()) {
      if (isOnline(s)) {
        online += 1;
        speedIn += num(s.net_in_speed) || 0;
        speedOut += num(s.net_out_speed) || 0;
      }
      monthly += (num(s.net_rx_monthly) || 0) + (num(s.net_tx_monthly) || 0);
    }
    statOnline.v.textContent = '';
    statOnline.v.append(`${online}`, el('em', { text: ` / ${dataMap.size}` }));
    statOnline.s.textContent = `${dataMap.size - online} 离线`;
    statOnline.s.style.display = dataMap.size - online > 0 ? '' : 'none';
    statDown.v.textContent = fmtSpeed(speedIn);
    statUp.v.textContent = fmtSpeed(speedOut);
    statMonth.v.textContent = fmtBytes(monthly);
  }

  // ----- WebSocket 实时更新（全局统一 1s tick 回放） -----
  // 全局单一定时器：样本回放与界面秒级刷新共用同一个 tick，
  // 所有卡片以相同频率同步变化，避免各服务器各自计时导致的杂乱跳变
  const playback = new Playback(
    (serverId, data, ts, displayTs, meta) => {
      const cur = dataMap.get(serverId);
      if (!cur) return;
      Object.assign(cur, data);
      // 在线判定使用批次上报时间（对齐官方 last_updated = report_timestamp）：
      // 回放过期缓存批次时服务器按真实上报时间离线，而非回放期间"假在线"
      cur.last_updated = meta && meta.reportTs ? meta.reportTs : Date.now();
      // 采集/上报时间：保留 report_ts / display_ts / batch_size 供显示逻辑判断
      cur.sample_ts = ts;
      cur.display_ts = displayTs;
      cur.report_ts = meta ? meta.reportTs : null;
      cur.batch_size = meta ? meta.batchSize : 1;
    },
    () => {
      // onTick：同步展示时钟（(+Ns) 每秒增长），再统一驱动所有卡片刷新
      for (const [sid, d] of dataMap) {
        const c = playback.displayTs(sid);
        if (c && d.sample_ts) d.display_ts = c;
      }
      for (const [sid, ref] of cardRefs) ref.update(dataMap.get(sid));
      for (const [sid, ref] of tableRefs) ref.update(dataMap.get(sid));
      refreshStats();
    },
    { isOnline: (sid) => isOnline(dataMap.get(sid)) },
  );

  // 以 /api/servers 已合并的指标时间为种子（对齐官方 mergeServersIntoList）：
  // 避免首批实时消息重复回放已展示数据；无缓存批次可回放的在线服务器
  // 也立即显示时间行，展示时钟从指标时间起步、lag 随 tick 增长
  for (const s of servers) {
    const ts = normalizeTs(s.sample_ts ?? s.sample_timestamp ?? s.last_updated, null);
    if (!ts) continue;
    playback.seed(s.id, ts);
    const d = dataMap.get(s.id);
    d.sample_ts = ts;
    d.display_ts = ts;
  }

  // 初始数据：latestReportUpdates 经统一回放管线消化（对齐官方 replayCachedReport），
  // 以 reportAgeMs 把缓存批次平移到当前时间线，再回放追赶到最新样本
  for (const u of payload.latestReportUpdates || []) {
    playback.queue(u.serverId, u.samples, u.reportTs, {
      replayCachedReport: true,
      reportAgeMs: u.reportAgeMs,
    });
  }

  // ----- 组装 -----
  view.textContent = '';
  view.append(statsGrid, regionRow, toolbar, groupsBox);
  renderList();
  refreshStats();

  playback.start();

  const socket = new MetricSocket({
    scope: 'all',
    ids: [...dataMap.keys()],
    onState: ctx.setWsState,
    onBatch(msg) {
      for (const u of msg.updates || []) {
        playback.queue(u.serverId, u.samples, u.reportTs ?? u.report_timestamp ?? msg.ts);
      }
    },
  });

  return {
    destroy() {
      playback.destroy();
      socket.close();
    },
  };
}

