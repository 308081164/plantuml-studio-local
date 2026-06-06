import { app, Menu, dialog, BrowserWindow, shell } from 'electron';

function sendToRenderer(channel) {
  const w = BrowserWindow.getFocusedWindow();
  if (w && !w.isDestroyed()) w.webContents.send(channel);
}

/** 构建中文应用菜单（Windows / Linux）；macOS 会追加应用菜单 */
export function buildZhMenu() {
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [];

  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: `关于 ${app.name}` },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    });
  }

  template.push(
    {
      label: '文件',
      submenu: [
        {
          label: '授权激活',
          click: () => sendToRenderer('studio:menu-license'),
        },
        { type: 'separator' },
        {
          label: '查看本次执行日志',
          click: () => sendToRenderer('studio:menu-session-log'),
        },
        {
          label: '查看错误日志',
          click: () => sendToRenderer('studio:menu-error-log'),
        },
        { type: 'separator' },
        ...(process.platform === 'darwin'
          ? [{ role: 'close', label: '关闭窗口' }]
          : [{ role: 'quit', label: '退出' }]),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'delete', label: '删除' },
        { type: 'separator' },
        {
          label: '复制预览图到剪贴板（PNG）',
          accelerator: 'Ctrl+Shift+Y',
          click: () => {
            const w = BrowserWindow.getFocusedWindow();
            if (w && !w.isDestroyed()) w.webContents.send('studio:menu-copy-preview');
          },
        },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载', accelerator: 'Ctrl+R' },
        { role: 'forceReload', label: '强制重新加载', accelerator: 'Ctrl+Shift+R' },
        { role: 'toggleDevTools', label: '切换开发者工具', accelerator: 'Ctrl+Shift+I' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小', accelerator: 'Ctrl+0' },
        { role: 'zoomIn', label: '放大', accelerator: 'Ctrl+=' },
        { role: 'zoomOut', label: '缩小', accelerator: 'Ctrl+-' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏幕', accelerator: 'F11' },
      ],
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: 'PlantUML 语法速查（应用内）',
          click: () => sendToRenderer('studio:menu-plantuml-guide'),
        },
        {
          label: 'PlantUML 文档',
          click: async () => {
            await shell.openExternal('https://plantuml.com/zh/guide');
          },
        },
        {
          label: 'Eclipse Temurin 许可说明',
          click: async () => {
            await shell.openExternal('https://adoptium.net/docs/faq/');
          },
        },
        { type: 'separator' },
        {
          label: '关于 PlantUML 本地工作室',
          click: async () => {
            const win = BrowserWindow.getFocusedWindow();
            await dialog.showMessageBox(win || undefined, {
              type: 'info',
              title: '关于',
              message: 'PlantUML 本地工作室',
              detail: [
                `版本 ${app.getVersion()}（M3 Beta：项目目录 + DeepSeek 制图）`,
                '',
                '内置 PlantUML PicoWeb 与本机/捆绑 JRE 渲染；DeepSeek 仅在您主动使用智能功能时联网。',
                '',
                '执行日志与错误归档见菜单「文件」。',
                '',
                '—— 售后与维护 ——',
                '· 售后 / 技术 / 激活问题请联系微信：hui3080811164',
                '· 软件购买请认准闲鱼店铺「广厦智汇科技」或「小夏AI」',
                '· 严禁转卖；无法提供购买凭证者不提供售后与技术服务',
                '',
                '任务栏：请右键桌面或开始菜单中的快捷方式，选择「固定到任务栏」。',
              ].join('\n'),
            });
          },
        },
      ],
    }
  );

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
