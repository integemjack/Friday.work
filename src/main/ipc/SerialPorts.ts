// 客户端设备的串口许可（方案-客户端设备）：渲染进程用 WebSerial 开串口，授权由应用自己的弹窗管，
// 所以不走系统的选择框（requestPort），而是让 getPorts() 直接列出全部串口。
//
// 渲染进程的 SerialPort 只给 USB VID/PID，拿不到 COM 名：Chromium 每次 getPorts() 都会为每个口问一遍
// 设备许可回调，回调里带完整信息（portName / displayName），这里顺手按顺序记下，渲染进程列完口紧接着来取，
// 再按「同一 VID:PID 里的先后」对上号。

import { ipcMain, type Session } from 'electron'

export interface SerialPortName {
  portName: string
  displayName?: string
  vendorId?: number
  productId?: number
}

interface Seen extends SerialPortName {
  portId: string
  at: number
}

/** 最近一轮 getPorts() 里见到的口（按回调顺序，同一 portId 只留第一次） */
const seen: Seen[] = []
const WINDOW_MS = 3_000

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value !== 'string' || value === '') return undefined
  // Electron 给的是十进制字符串（如 Arduino 的 '9025'）；带 0x 的也认
  const parsed = value.startsWith('0x') ? Number.parseInt(value, 16) : Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function record(device: Record<string, unknown>): void {
  const portId = String(device.portId ?? '')
  const portName = String(device.portName ?? '')
  if (!portId || !portName) return
  const now = Date.now()
  while (seen.length > 0 && now - seen[0].at > WINDOW_MS) seen.shift()
  if (seen.some((entry) => entry.portId === portId)) return
  seen.push({
    portId,
    portName,
    displayName: typeof device.displayName === 'string' ? device.displayName : undefined,
    vendorId: toNumber(device.vendorId),
    productId: toNumber(device.productId),
    at: now
  })
}

export function registerSerialPorts(session: Session): void {
  session.setDevicePermissionHandler((details) => {
    if (details.deviceType !== 'serial') return false
    record(details.device as unknown as Record<string, unknown>)
    return true
  })
  // 应用从不调 requestPort；万一有，直接取消，别弹 Chromium 的选择框
  session.on('select-serial-port', (event, _portList, _webContents, callback) => {
    event.preventDefault()
    callback('')
  })
  ipcMain.handle('serial:port-names', (): SerialPortName[] => {
    const now = Date.now()
    return seen
      .filter((entry) => now - entry.at <= WINDOW_MS)
      .map(({ portName, displayName, vendorId, productId }) => ({ portName, displayName, vendorId, productId }))
  })
}
