// Pulse 主题 · 应用入口
// 职责：配色模式、站点配置加载、顶栏/页脚、hash 路由（#/ 与 #/server/:id）
//
// 支持的主题自定义项（管理端「主题设置」theme_options，均为可选）：
//   accent: "#2dd4bf"   主题强调色
//   mode:   "dark" | "light"   默认配色模式（用户手动切换后优先用户选择）

const THEME_VERSION = 'v1.2.0';

import {el, fmtClock, serverNow, stateBlock, svg} from './utils.js?v=1.2.0';
import {getConfig} from './api.js?v=1.2.0';
import {renderHome} from './views/home.js?v=1.2.0';
import {renderDetail} from './views/detail.js?v=1.2.0';

const html = document.documentElement;
const THEME_KEY = 'probe_color_mode';

// ---------- 配色模式（尽早应用，避免闪烁） ----------

function initialColorMode() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    /* ignore */
  }
  if (saved === 'light' || saved === 'dark') return saved;
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}
html.dataset.theme = initialColorMode();

// ---------- 全局上下文 ----------

const ctx = {
  config: null,
  setWsState: () => {},
  refresh: () => route(),
};

let currentView = null;
let routed = false;

async function route() {
  if (currentView && currentView.destroy) currentView.destroy();
  currentView = null;
  const main = document.getElementById('main');
  main.textContent = '';
  const m = location.hash.match(/^#\/server\/(.+)$/);
  if (m) currentView = await renderDetail(main, ctx, decodeURIComponent(m[1]));
  else currentView = await renderHome(main, ctx);
  window.scrollTo(0, 0);
}

// ---------- 图标 ----------

function sunIcon() {
  return svg(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' },
    svg('circle', { cx: '12', cy: '12', r: '4.2' }),
    svg('path', { d: 'M12 2.5v2.4M12 19.1v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7' }),
  );
}

function moonIcon() {
  return svg(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    svg('path', { d: 'M20.4 14.2A8.5 8.5 0 1 1 9.8 3.6a7 7 0 1 0 10.6 10.6Z' }),
  );
}

// ---------- 顶栏 / 页脚 ----------

function renderHeader(config) {
  const header = document.getElementById('site-header');
  header.textContent = '';

  const brand = el(
    'a',
    { class: 'brand', href: '#/' },
    el('span', { class: 'pulse-logo' }),
    el(
      'span',
      { class: 'brand-text' },
      el('span', { class: 'brand-title', text: config.site_title || 'Server Monitor' }),
    ),
  );
  brand.addEventListener('click', (e) => {
    e.preventDefault();
    location.hash = '';
  });

  // WebSocket 状态指示
  const pillText = el('span', { class: 'ws-pill-text', text: '未连接' });
  const pill = el('span', { class: 'ws-pill' }, el('i', { class: 'pill-dot' }), pillText);
  ctx.setWsState = (s) => {
    pill.className = `ws-pill ${s === 'open' ? 'on' : s === 'connecting' ? 'mid' : 'off'}`;
    pillText.textContent = s === 'open' ? '实时' : s === 'connecting' ? '连接中' : '断开';
  };

  // 深浅色切换
  const toggle = el('button', { class: 'icon-btn', title: '切换深色 / 浅色', 'aria-label': '切换配色模式' });
  const syncIcon = () => {
    toggle.textContent = '';
    toggle.append(html.dataset.theme === 'light' ? moonIcon() : sunIcon());
  };
  toggle.addEventListener('click', () => {
    html.dataset.theme = html.dataset.theme === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem(THEME_KEY, html.dataset.theme);
    } catch {
      /* ignore */
    }
    syncIcon();
  });
  syncIcon();

  const clock = el('span', { class: 'clock mono' });
  const tick = () => {
    clock.textContent = fmtClock(serverNow());
  };
  tick();
  setInterval(tick, 1000);

  header.append(brand, el('div', { class: 'header-right' }, pill, toggle, clock));
}

function renderFooter(config) {
  const footer = document.getElementById('site-footer');
  footer.textContent = '';
  footer.append(
    el('a', {
      class: 'f-brand',
      href: 'https://github.com/huilang-me/CF-Server-Monitor',
      target: '_blank',
      rel: 'noopener',
      text: 'CF-Server-Monitor',
    }),
    el('span', { text: ` ${config.version || ''} · ` }),
    el('a', {
      class: 'f-brand',
      href: 'https://github.com/loongkong/cf-server-monitor-theme-pulse',
      target: '_blank',
      rel: 'noopener',
      text: 'Pulse',
    }),
    el('span', { text: ` ${THEME_VERSION}` }),
  );
}

// ---------- 主题自定义项 ----------

function applyThemeOptions(options) {
  if (!options || typeof options !== 'object') return;
  if (typeof options.accent === 'string' && /^#[0-9a-f]{3,8}$/i.test(options.accent)) {
    html.style.setProperty('--accent', options.accent);
  }
  // 未手动选择过配色时，遵循主题配置的默认模式
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    /* ignore */
  }
  if (!saved && (options.mode === 'light' || options.mode === 'dark')) {
    html.dataset.theme = options.mode;
  }
}

// ---------- 启动 ----------

async function boot() {
  const main = document.getElementById('main');
  try {
    const config = await getConfig();
    ctx.config = config;
    if (config.site_title) document.title = config.site_title;
    applyThemeOptions(config.theme_options);
    renderHeader(config);
    renderFooter(config);
    if (!routed) {
      routed = true;
      window.addEventListener('hashchange', route);
    }
    await route();
  } catch (err) {
    main.textContent = '';
    main.append(
      stateBlock({
        icon: 'err',
        title: '初始化失败',
        desc: err.message || '无法获取站点配置',
        actionText: '重试',
        onAction: () => window.location.reload(),
      }),
    );
  }
}

boot();

