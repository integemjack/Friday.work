// 客户端设备：串口的标识与显示名（方案-客户端设备 §5.1）。
//
// WebSerial 的 SerialPort 只给 USB VID/PID；COM 名由主进程从设备许可回调里记下（按枚举顺序），
// 这里按「同一 VID:PID 里的先后」对上号。id 在一次运行里对同一个 SerialPort 对象保持不变
// （Chromium 对同一个口返回同一个对象），拔插后同型号的新口拿下一个空着的序号。

export interface PortNameInfo {
  portName: string
  displayName?: string
  vendorId?: number
  productId?: number
}

export interface SerialDeviceInfo {
  id: string
  kind: 'serial'
  label: string
  portName?: string
  usbVendorId?: number
  usbProductId?: number
  /** 常见 ESP 开发板的 USB 转串口芯片 / ESP 原生 USB */
  espHint: boolean
}

interface Bridge {
  name: string
  esp: boolean
}

/** 常见 USB 转串口芯片（开发板上那颗）；VID 0x303A 是 Espressif 自家（S2/S3/C3/C6 的原生 USB） */
const BRIDGES: Record<string, Bridge> = {
  '10c4:ea60': { name: 'CP210x', esp: true },
  '1a86:7523': { name: 'CH340', esp: true },
  '1a86:5523': { name: 'CH341', esp: true },
  '1a86:55d3': { name: 'CH343', esp: true },
  '1a86:55d4': { name: 'CH9102', esp: true },
  '0403:6001': { name: 'FT232R', esp: false },
  '0403:6010': { name: 'FT2232', esp: true },
  '0403:6014': { name: 'FT232H', esp: false },
  '0403:6015': { name: 'FT231X', esp: false }
}

const VENDORS: Record<string, Bridge> = {
  '303a': { name: 'ESP USB', esp: true },
  '2341': { name: 'Arduino', esp: false },
  '2e8a': { name: 'Raspberry Pi', esp: false }
}

function hex4(value: number | undefined): string {
  return value === undefined ? 'xxxx' : value.toString(16).padStart(4, '0')
}

export function bridgeFor(vendorId?: number, productId?: number): Bridge | null {
  if (vendorId === undefined) return null
  return BRIDGES[`${hex4(vendorId)}:${hex4(productId)}`] ?? VENDORS[hex4(vendorId)] ?? null
}

function groupKey(vendorId?: number, productId?: number): string {
  return `${vendorId ?? 'x'}:${productId ?? 'x'}`
}

/** 给 SerialPort 对象分配稳定的 id（同型号按出现顺序编号，序号空出来可复用） */
export class SerialIdRegistry<P> {
  private readonly ids = new Map<P, string>()

  idFor(port: P, vendorId?: number, productId?: number): string {
    const known = this.ids.get(port)
    if (known) return known
    const prefix = `serial:${groupKey(vendorId, productId)}:`
    const used = new Set([...this.ids.values()].filter((id) => id.startsWith(prefix)))
    let index = 0
    while (used.has(prefix + index)) index++
    const id = prefix + index
    this.ids.set(port, id)
    return id
  }

  /** 拔掉的口：放出序号 */
  forget(port: P): void {
    this.ids.delete(port)
  }

  portFor(id: string): P | undefined {
    for (const [port, known] of this.ids) if (known === id) return port
    return undefined
  }
}

/**
 * 把一轮枚举的口和主进程记下的 COM 名对上：同一 VID:PID 里第 i 个口配第 i 个名字。
 * ports 与 names 都按 Chromium 的枚举顺序。
 */
export function describePorts(
  ports: Array<{ id: string; usbVendorId?: number; usbProductId?: number }>,
  names: PortNameInfo[]
): SerialDeviceInfo[] {
  const namesByGroup = new Map<string, PortNameInfo[]>()
  for (const name of names) {
    const key = groupKey(name.vendorId, name.productId)
    const list = namesByGroup.get(key) ?? []
    list.push(name)
    namesByGroup.set(key, list)
  }
  const taken = new Map<string, number>()
  const sameModel = new Map<string, number>()
  for (const port of ports) {
    const key = groupKey(port.usbVendorId, port.usbProductId)
    sameModel.set(key, (sameModel.get(key) ?? 0) + 1)
  }

  return ports.map((port) => {
    const key = groupKey(port.usbVendorId, port.usbProductId)
    const index = taken.get(key) ?? 0
    taken.set(key, index + 1)
    const name = namesByGroup.get(key)?.[index]
    const bridge = bridgeFor(port.usbVendorId, port.usbProductId)
    const model = bridge?.name ?? (port.usbVendorId === undefined ? '串口' : `USB ${hex4(port.usbVendorId)}:${hex4(port.usbProductId)}`)
    const ordinal = (sameModel.get(key) ?? 0) > 1 ? ` #${index + 1}` : ''
    const label = name ? `${name.portName} · ${model}` : `${model}${ordinal}`
    return {
      id: port.id,
      kind: 'serial' as const,
      label,
      ...(name ? { portName: name.portName } : {}),
      ...(port.usbVendorId !== undefined ? { usbVendorId: port.usbVendorId } : {}),
      ...(port.usbProductId !== undefined ? { usbProductId: port.usbProductId } : {}),
      espHint: bridge?.esp ?? false
    }
  })
}
