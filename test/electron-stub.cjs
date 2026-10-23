// 单测用的最小 electron 替身（downloads-main.test.cjs 把 require('electron') 指到这里）：
// ipcMain.handle 登记到表里供测试直接调；对话框的返回值由测试通过 __setDialog 指定。
const handlers = new Map()
let dialogResult = { canceled: true }
const revealed = []

module.exports = {
  ipcMain: {
    handle(channel, fn) {
      handlers.set(channel, fn)
    }
  },
  dialog: {
    async showSaveDialog() {
      return dialogResult
    },
    async showOpenDialog() {
      return dialogResult
    }
  },
  app: {
    getPath() {
      return require('node:os').tmpdir()
    }
  },
  shell: {
    showItemInFolder(path) {
      revealed.push(path)
    }
  },
  BrowserWindow: class {},
  __handlers: handlers,
  __revealed: revealed,
  __setDialog(result) {
    dialogResult = result
  }
}
