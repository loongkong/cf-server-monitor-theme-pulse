// 通用工具：DOM 构建、格式化、状态计算
// 注意：为兼容站点 CSP（style-src-attr 可能禁用内联样式），
// 动态样式一律通过 node.style.xxx 属性赋值，不使用 style 属性 / innerHTML。

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------- 服务器时钟 ----------
// 数据语义上的"现在"以服务器时间为准（用户本地时钟可能走快/走慢）。
// 锚点：API 响应的 Date 头、WS batchUpdate 的服务端时间戳；
// 两次同步之间用单调时钟 performance.now() 推进，下次响应到达时再修正。
// serverNow() 保证单调不回退，避免 UI 时间抖动。

let _clockOffset = null; // 服务器时间 − performance.now()
let _clockLast = 0;

/** 用服务端时间戳（毫秒；秒级或数字字符串亦可）校准时钟 */
export function syncServerTime(value) {
  let t = Number(value);
  if (!Number.isFinite(t) || t <= 0) return;
  if (t < 10_000_000_000) t *= 1000;
  _clockOffset = t - performance.now();
}

/** 服务器时间的"现在"；尚未同步过时回退到本地时钟 */
export function serverNow() {
  const t = _clockOffset == null ? Date.now() : Math.round(performance.now() + _clockOffset);
  _clockLast = Math.max(_clockLast, t);
  return _clockLast;
}

/** 创建 HTML 元素。attrs 支持 class / text / dataset / style(对象) / onXxx(函数) / 其他属性 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value);
  }
  appendChildren(node, children);
  return node;
}

/** 创建 SVG 元素 */
export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v != null) node.setAttribute(k, v);
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendChildren(node, c);
    else node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

// ---------- 数值解析 ----------

export function num(v) {
  if (v == null || v === '' || v === false) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function pct(used, total) {
  const u = num(used);
  const t = num(total);
  if (u == null || !t) return null;
  return clamp((u / t) * 100, 0, 100);
}

// ---------- 格式化 ----------

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function fmtBytes(n, digits = 1) {
  const v = num(n);
  if (v == null) return '—';
  let val = Math.abs(v);
  let i = 0;
  while (val >= 1024 && i < BYTE_UNITS.length - 1) {
    val /= 1024;
    i++;
  }
  const text = i === 0 ? String(Math.round(val)) : val.toFixed(digits);
  return `${v < 0 ? '-' : ''}${text} ${BYTE_UNITS[i]}`;
}

export function fmtSpeed(n) {
  const v = num(n);
  return v == null ? '—' : fmtBytes(v) + '/s';
}

/** 内存/磁盘（MB）→ 可读文本 */
export function fmtMB(mb) {
  const v = num(mb);
  if (v == null) return '—';
  if (v >= 1024) return fmtBytes(v * 1024 * 1024);
  return `${Math.round(v)} MB`;
}

export function fmtPct(v, digits = 1) {
  const n = num(v);
  return n == null ? '—' : n.toFixed(digits) + '%';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function fmtClock(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 时钟时间 + 距当前秒数：19:00:02(+10s) */
export function lagText(now, ts) {
  return `${fmtClock(ts)}(+${Math.max(0, Math.round((now - ts) / 1000))}s)`;
}

export function fmtTimeShort(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtDateTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 运行时长（boot_time 毫秒时间戳 → "32天" / "5时20分"） */
export function fmtUptime(bootMs) {
  const t = num(bootMs);
  if (!t) return '—';
  let s = Math.max(0, Math.floor((serverNow() - t) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return h > 0 ? `${d}天${h}时` : `${d}天`;
  if (h > 0) return `${h}时${m}分`;
  return `${m}分`;
}

export function timeAgo(ts) {
  const t = num(ts);
  if (!t) return '无数据';
  const diff = Math.max(0, serverNow() - t);
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

// ---------- 服务器状态 ----------

/** 与后端一致：5 分钟无上报视为离线 */
export const ONLINE_WINDOW = 300_000;

export function isOnline(s) {
  const t = num(s && s.last_updated);
  return !!t && serverNow() - t < ONLINE_WINDOW;
}

/** IP 可达性：兼容旧格式 "1"/"0" 与新格式（真实公网 IP 字符串 / "0"） */
export function ipReachable(v) {
  return v != null && String(v) !== '' && String(v) !== '0';
}

/** ping 字段可能是 number | null | false（false = 禁用该节点） */
export function pingState(v) {
  if (v === false || v === 'false') return { kind: 'disabled', value: null };
  const n = num(v);
  return n == null ? { kind: 'none', value: null } : { kind: 'ok', value: n };
}

// 阈值对齐官方主题：good <100ms，mid <200ms，bad ≥200ms
export function pingClass(ms) {
  if (ms == null) return '';
  return ms < 100 ? 'good' : ms < 200 ? 'mid' : 'bad';
}

export function avgPing(s) {
  const vals = ['ping_ct', 'ping_cu', 'ping_cm', 'ping_bd']
    .map((k) => pingState(s[k]))
    .filter((p) => p.kind === 'ok')
    .map((p) => p.value);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** 价格文本："0" / "-1"（含两位小数形式 "0.00"）表示免费，空白表示未设置 */
export function priceText(price, currency) {
  if (price == null || String(price).trim() === '') return null;
  const p = String(price).trim();
  const n = parseFloat(p);
  if (Number.isFinite(n) && n <= 0) return '免费';
  return `${currency || '¥'}${p}`;
}

/** OS 名称压缩：去掉 GNU/Linux、Linux 冗余词，适配磁贴窄宽度（完整名放 title） */
export function shortOS(os) {
  return String(os || '')
    .replace(/\s+GNU\/Linux/g, '')
    .replace(/\s+Linux(?=\s|$)/g, '')
    .trim();
}

/** OS 名称 → 发行版短名 + 大版本号（如 Debian GNU/Linux 12 → Debian 12），用于首页卡片 meta 行 */
export function osName(os) {
  const s = String(os || '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  const KNOWN = [
    ['almalinux', 'AlmaLinux'],
    ['alpine', 'Alpine'],
    ['arch', 'Arch'],
    ['centos', 'CentOS'],
    ['debian', 'Debian'],
    ['ubuntu', 'Ubuntu'],
    ['windows', 'Windows'],
    ['macos', 'macOS'],
    ['darwin', 'macOS'],
    ['rocky', 'Rocky'],
    ['fedora', 'Fedora'],
    ['opensuse', 'openSUSE'],
    ['kali', 'Kali'],
    ['mint', 'Mint'],
    ['manjaro', 'Manjaro'],
    ['armbian', 'Armbian'],
    ['gentoo', 'Gentoo'],
    ['redhat', 'Red Hat'],
    ['rhel', 'Red Hat'],
    ['nixos', 'NixOS'],
    ['openwrt', 'OpenWrt'],
    ['immortalwrt', 'ImmortalWrt'],
    ['proxmox', 'Proxmox'],
    ['synology', 'Synology'],
    ['alibaba', 'Alibaba'],
    ['opencloud', 'OpenCloudOS'],
    ['oracle', 'Oracle'],
    ['freebsd', 'FreeBSD'],
    ['suse', 'openSUSE'],
    ['alma', 'AlmaLinux'],
  ];
  let name = '';
  for (const [kw, n] of KNOWN) {
    if (lower.includes(kw)) {
      name = n;
      break;
    }
  }
  if (!name) name = s.split(/[\s/]/)[0];
  // 附加大版本号（首个数字段，至多一位小数）：Debian 12、Ubuntu 22.04、Windows 2022
  const m = s.match(/\d+(?:\.\d+)?/);
  return m && !name.includes(m[0]) ? `${name} ${m[0]}` : name;
}

/** OS 图标：/os-icons/<file> 由后端默认皮肤提供；关键字匹配对齐官方 osIcon.js，
 *  注意特殊文件名（os-kail / os-openSUSE / os-manjaro-）与大小写 */
const OS_ICON_RULES = [
  ['almalinux', 'os-alma.svg'],
  ['alpine', 'os-alpine.webp'],
  ['centos', 'os-centos.svg'],
  ['debian', 'os-debian.svg'],
  ['ubuntu', 'os-ubuntu.svg'],
  ['elementary', 'os-ubuntu.svg'],
  ['macos', 'os-macos.svg'],
  ['mac os', 'os-macos.svg'],
  ['darwin', 'os-macos.svg'],
  ['windows', 'os-windows.svg'],
  ['microsoft', 'os-windows.svg'],
  ['arch', 'os-arch.svg'],
  ['kali', 'os-kail.svg'],
  ['istore', 'os-istore.png'],
  ['openwrt', 'os-openwrt.svg'],
  ['immortalwrt', 'os-openwrt.svg'],
  ['qwrt', 'os-openwrt.svg'],
  ['nixos', 'os-nix.svg'],
  ['rocky', 'os-rocky.svg'],
  ['fedora', 'os-fedora.svg'],
  ['opensuse', 'os-openSUSE.svg'],
  ['suse', 'os-openSUSE.svg'],
  ['gentoo', 'os-gentoo.svg'],
  ['redhat', 'os-redhat.svg'],
  ['rhel', 'os-redhat.svg'],
  ['mint', 'os-mint.svg'],
  ['manjaro', 'os-manjaro-.svg'],
  ['armbian', 'os-armbian.png'],
  ['synology', 'os-synology.ico'],
  ['dsm', 'os-synology.ico'],
  ['proxmox', 'os-proxmox.ico'],
  ['alibaba', 'os-alibaba.svg'],
  ['aliyun', 'os-alibaba.svg'],
  ['anolis', 'os-alibaba.svg'],
  ['龙蜥', 'os-alibaba.svg'],
  ['opencloud', 'os-opencloud.svg'],
  ['oracle', 'os-oracle.svg'],
];

function osIconFile(os) {
  const s = String(os || '').toLowerCase().trim();
  if (!s) return null;
  for (const [kw, file] of OS_ICON_RULES) {
    if (s.includes(kw)) return file;
  }
  return 'os-unknown.svg';
}

export function osIconImg(os) {
  const img = el('img', { class: 'os-img', alt: '', loading: 'lazy' });
  img.onerror = () => {
    img.style.display = 'none';
  };
  updateOsIconImg(img, os);
  return img;
}

/** 更新 OS 图标；无 OS 数据时隐藏 */
export function updateOsIconImg(img, os) {
  const file = osIconFile(os);
  if (file) {
    img.style.display = '';
    const src = `/os-icons/${file}`;
    if (!img.src.endsWith(src)) img.src = src;
  } else {
    img.style.display = 'none';
  }
}

/** 旗帜 <img>：/flags/<cc>.svg 由后端默认皮肤提供（Windows 无国旗 emoji，不能用字符）。
 *  文件名小写（大写会命中 SPA 兜底返回 HTML）；TW 沿用官方的 cn 映射 */
function flagFile(cc) {
  const code = String(cc || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return code === 'TW' ? 'cn' : code.toLowerCase();
}

export function flagImg(cc) {
  const img = el('img', { class: 'flag-img', alt: String(cc || '').toUpperCase(), loading: 'lazy' });
  img.onerror = () => {
    img.style.display = 'none';
  };
  updateFlagImg(img, cc);
  return img;
}

/** 更新旗帜图片；非法区域码时隐藏 */
export function updateFlagImg(img, cc) {
  const file = flagFile(cc);
  if (file) {
    img.style.display = '';
    const src = `/flags/${file}.svg`;
    if (!img.src.endsWith(src)) img.src = src;
  } else {
    img.style.display = 'none';
  }
}

/** gpu_info 兼容数组 / JSON 字符串 / null */
export function parseGPU(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 解析 "1TB" / "500GB" 之类的流量限额文本 → 字节数 */
export function parseTrafficLimit(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB|PB)?$/i);
  if (!m) return null;
  const powers = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4, PB: 5 };
  const unit = (m[2] || 'GB').toUpperCase();
  const p = powers[unit];
  if (p == null) return null;
  return parseFloat(m[1]) * 1024 ** p;
}

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(`${dateStr}T00:00:00`);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - serverNow()) / 86_400_000);
}

const BILLING_MAP = {
  month: '月',
  quarter: '季',
  half_year: '半年',
  year: '年',
  two_years: '2年',
  three_years: '3年',
  four_years: '4年',
  five_years: '5年',
};

export function billingText(cycle) {
  return BILLING_MAP[cycle] || '期';
}

// ---------- 图标系统 ----------
// 统一 24x24 线性图标（stroke），随 currentColor 着色

const ICON_PATHS = {
  cpu: [
    'M7 7h10v10H7z',
    'M10.5 10.5h3v3h-3z',
    'M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3',
  ],
  layers: ['M12 3 3.5 7.5 12 12l8.5-4.5L12 3Z', 'M3.5 12 12 16.5 20.5 12'],
  swap: ['M7 3.5 3.5 7 7 10.5', 'M3.5 7H16', 'M17 13.5l3.5 3.5-3.5 3.5', 'M20.5 17H8'],
  disk: [
    'M12 3.5c4.4 0 8 1.1 8 2.5s-3.6 2.5-8 2.5-8-1.1-8-2.5 3.6-2.5 8-2.5Z',
    'M4 6v12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V6',
    'M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5',
  ],
  gauge: ['M4.5 19a9.5 9.5 0 1 1 15 0', 'M12 14l4.5-4.5', 'M12 14h.01'],
  activity: ['M3 12h4l2.5-6.5L14 18l2.5-6h4.5'],
  pie: ['M12 3.5a8.5 8.5 0 1 0 8.5 8.5H12V3.5Z', 'M14.5 3a8.5 8.5 0 0 1 6.5 6.5h-6.5V3Z'],
  list: ['M8 6.5h12M8 12h12M8 17.5h12', 'M4 6.5h.01M4 12h.01M4 17.5h.01'],
  signal: ['M5 15.5v3', 'M10 12v6.5', 'M15 8.5v9.5', 'M20 4.5v13.5'],
  server: [
    'M4 4.5h16a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z',
    'M4 14.5h16a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z',
    'M6.5 7h.01M6.5 17h.01',
  ],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5.5l3.5 2'],
  globe: [
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
    'M3 12h18',
    'M12 3c2.8 2.4 4.2 5.4 4.2 9s-1.4 6.6-4.2 9c-2.8-2.4-4.2-5.4-4.2-9s1.4-6.6 4.2-9Z',
  ],
  gpu: [
    'M4.5 6h15a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5v-9A1.5 1.5 0 0 1 4.5 6Z',
    'M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
    'M7.5 3v3M16.5 3v3M7.5 18v3M16.5 18v3',
  ],
  tag: ['M3.5 10.5v-6a1 1 0 0 1 1-1h6L20 13l-7 7-9.5-9.5Z', 'M8 8h.01'],
  calendar: [
    'M4.5 5h15a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12A1.5 1.5 0 0 1 4.5 5Z',
    'M8 3v4M16 3v4M3 10h18',
  ],
  card: [
    'M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 17V7a1.5 1.5 0 0 1 1.5-1.5Z',
    'M2.5 9.5h19',
    'M6 14.5h4',
  ],
};

export function icon(name, cls = 'ico') {
  const paths = ICON_PATHS[name] || [];
  return svg(
    'svg',
    {
      viewBox: '0 0 24 24',
      class: cls,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.8',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    paths.map((d) => svg('path', { d })),
  );
}

// ---------- 反馈组件 ----------

let toastTimer = null;

export function toast(msg) {
  const root = document.getElementById('toast-root') || document.body;
  root.textContent = '';
  const t = el('div', { class: 'toast show', text: msg });
  root.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 320);
  }, 3200);
}

/** 空状态 / 错误状态块 */
export function stateBlock({ icon = 'empty', title, desc, actionText, onAction }) {
  const icons = {
    empty: 'M20 7H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2ZM2 11h20M7 15h4',
    lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5V11Zm7 4v2',
    err: 'M12 8v5m0 3.5v.5M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  };
  const iconSvg = svg(
    'svg',
    {
      viewBox: '0 0 24 24',
      class: 'state-icon',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    svg('path', { d: icons[icon] || icons.empty }),
  );
  return el(
    'div',
    { class: 'state-block' },
    iconSvg,
    el('h3', { class: 'state-title', text: title }),
    desc ? el('p', { class: 'state-desc', text: desc }) : null,
    actionText ? el('button', { class: 'btn', onClick: () => onAction && onAction() }, actionText) : null,
  );
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

