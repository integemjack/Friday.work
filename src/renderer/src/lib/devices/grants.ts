// 客户端设备：「始终允许」的授权（方案-客户端设备 §4）。按 机器 × 能力 × 设备 记，设置里可撤销。
// 存 localStorage：只是这台电脑上这个人的选择，不用同步给谁；读写失败就当没授权过（每次都问）。

import { reactive } from 'vue'

/** serial = 开串口会话；esp = 烧录 / 读芯片（ESP、UF2、Arduino、STM32 都算）；camera = 拍照；
 *  network = 连局域网 / 本机的 host:port；android = 把一台安卓手机交给服务端的 adb；ios = 交出 usbmuxd；
 *  tool = 在这台电脑上跑烧录 / 调试工具（每次都问，没有「始终允许」） */
export type DeviceCapability = 'serial' | 'esp' | 'camera' | 'network' | 'android' | 'ios' | 'tool'

export interface DeviceGrant {
  machineID: string
  machineName: string
  capability: DeviceCapability
  deviceId: string
  deviceLabel: string
  grantedAt: string
}

const STORAGE_KEY = 'friday.deviceGrants.v1'

function load(): DeviceGrant[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? (parsed as DeviceGrant[]).filter((grant) => grant && typeof grant.deviceId === 'string') : []
  } catch {
    return []
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(deviceGrants.list))
  } catch {
    /* 存不下：这次运行里仍然有效 */
  }
}

export const deviceGrants = reactive({ list: load() })

function same(grant: DeviceGrant, machineID: string, capability: DeviceCapability, deviceId: string): boolean {
  return grant.machineID === machineID && grant.capability === capability && grant.deviceId === deviceId
}

export function hasGrant(machineID: string, capability: DeviceCapability, deviceId: string): boolean {
  return deviceGrants.list.some((grant) => same(grant, machineID, capability, deviceId))
}

export function addGrant(grant: Omit<DeviceGrant, 'grantedAt'>): void {
  if (hasGrant(grant.machineID, grant.capability, grant.deviceId)) return
  deviceGrants.list.push({ ...grant, grantedAt: new Date().toISOString() })
  save()
}

export function revokeGrant(grant: Pick<DeviceGrant, 'machineID' | 'capability' | 'deviceId'>): void {
  deviceGrants.list = deviceGrants.list.filter((item) => !same(item, grant.machineID, grant.capability, grant.deviceId))
  save()
}

export const CAPABILITY_LABEL: Record<DeviceCapability, string> = {
  serial: '串口',
  esp: '烧录',
  camera: '摄像头',
  network: '局域网连接',
  android: '安卓手机',
  ios: 'iOS 设备',
  tool: '运行工具'
}
