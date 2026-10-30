/* View changes keep the real form nodes alive, including selection and focus. */
(() => {
  const byId = id => document.getElementById(id);
  let page = 'clip', tool = null, returnPage = 'clip', returnFocus = null;
  const positions = new Map();
  const route = new URL(location.href).searchParams;
  const manager = route.get('view') === 'wechat-manage';
  const settings = byId('popupAdvancedSettings');
  settings.querySelector('.advanced-content').append(byId('obsidianDock'));
  const sections = { clip: byId('workspaceShell'), tools: byId('toolsDrawer'), records: byId('recentSaves'), settings };
  function show(next, { restore = true } = {}) {
    positions.set(page, { y: scrollY, focus: document.activeElement });
    page = next;
    for (const [key, el] of Object.entries(sections)) { el.hidden = key !== next; if (el.tagName === 'DETAILS') el.open = key === next; }
    document.body.dataset.page = next;
    document.querySelectorAll('[data-page]').forEach(button => {
      if (button.dataset.page === next) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    byId('openExportSettings').setAttribute('aria-expanded', String(next === 'settings'));
    const saved = restore && positions.get(next);
    requestAnimationFrame(() => {
      scrollTo(0, saved?.y || 0);
      if (saved?.focus?.isConnected && saved.focus.getClientRects().length) saved.focus.focus({ preventScroll: true });
    });
  }
  function openSettings() {
    if (page === 'settings') return;
    returnPage = page; returnFocus = document.activeElement;
    show('settings', { restore: false });
    byId('backFromSettings').focus({ preventScroll: true });
  }
  function back() { show(returnPage); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); }
  function setTool(value) {
    tool = value;
    byId('toolsIndex').hidden = Boolean(tool);
    byId('categoryToolsPanel').hidden = !tool;
    byId('backToTools').hidden = !tool || manager;
    byId('toolPageTitle').textContent = ({ wechat: '公众号文章', feishu: '链接批量下载', scys: '课程专栏导出', other: '更多工具' })[tool] || '工具';
    show('tools', { restore: false });
    globalThis.dispatchEvent(new CustomEvent('popup-tool-change'));
  }
  document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => show(button.dataset.page)));
  byId('backFromSettings').addEventListener('click', back);
  byId('backToTools').addEventListener('click', () => setTool(null));
  byId('toggleSourceTitle').addEventListener('click', event => {
    const expanded = event.currentTarget.getAttribute('aria-expanded') !== 'true';
    event.currentTarget.setAttribute('aria-expanded', String(expanded));
    event.currentTarget.textContent = expanded ? '收起标题' : '展开标题';
    byId('docTitle').classList.toggle('title-expanded', expanded);
  });
  new ResizeObserver(() => {
    if (byId('toggleSourceTitle').getAttribute('aria-expanded') !== 'true') byId('toggleSourceTitle').hidden = byId('docTitle').scrollHeight <= byId('docTitle').clientHeight + 2;
  }).observe(byId('docTitle'));
  globalThis.PopupNavigation = { show, back, settings: openSettings, setTool, get tool() { return tool; }, get page() { return page; }, manager };
  if (manager) {
    document.body.classList.add('wechat-manager');
    document.documentElement.classList.add('manager-document');
    document.querySelector('.main-tabs').hidden = true;
    const side = document.createElement('aside');
    side.className = 'manager-side'; side.setAttribute('aria-label', '查询与本地下载');
    side.append(byId('wechatConditions'));
    side.append(document.querySelector('.history-download-options'));
    const footer = document.createElement('div'); footer.className = 'manager-action-footer';
    const localNote = byId('helperDownloadSelected').nextElementSibling;
    footer.append(byId('helperDownloadSelected'), localNote);
    side.append(footer); byId('wechatWorkspace').append(side);
    setTool('wechat');
  } else show('clip');
})();
