// 构建时注入的标识（electron.vite.config.ts main.define）：
// CI 打包时是构建提交的哈希（release.yml 传 GIT_COMMIT），本地 dev 是 'dev'。
// 自动更新用它判断 rolling 通道的「版本没动但构建新了」。
declare const __APP_COMMIT__: string
