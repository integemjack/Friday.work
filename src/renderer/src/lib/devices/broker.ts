// 客户端设备：服务端 device.* 请求的处理中心（方案-客户端设备）。
//
// 协议进程把请求经数据面端口转来（device.request），这里校验参数 → 认设备 → 问人授权 → 干活 → device.reply。
// 串口会话占着的口、正在烧录的口都记在 busy 里：同一个口同时只给一个用，烧录时把串口会话挂起、烧完接着转发。
// 界面要的东西（待授权的弹窗、正在用的设备）放在 deviceUi 里，DeviceOverlay 直接读。

import { reactive } from 'vue'
import { RpcErrors } from '../../../../protocol/rpc/protocol.js'
import type { DevicePortMessage } from '../../../../shared/api.js'
import { host } from '../host.js'
import type { WorkChannelHub } from '../workChannel.js'
import { CAMERA_PREFIX, listCameras, takeSnapshot, type CameraDeviceInfo } from './camera.js'
import { DeviceError, parseEspInfo, parseFlash, parseSerialOpen, parseSnapshot } from './deviceParams.js'
import { espInfo, flashEsp } from './espFlash.js'
import { addGrant, hasGrant, type DeviceCapability } from './grants.js'
import { SerialIdRegistry, describePorts, type SerialDeviceInfo } from './serialPorts.js'
import { SerialSession, type ChannelLike, type PortLike } from './serialSession.js'

type RequestMessage = Extract<DevicePortMessage, { type: 'device.request' }>

export type PromptChoice = 'once' | 'always' | 'deny'

export interface DevicePrompt {
  id: number
  machineName: string
  capability: DeviceCapability
  deviceLabel: string
  /** 要干什么（一句话） */
  action: string
  expiresAt: number
}

export interface DeviceActivity {
  key: string
  machineName: string
  kind: 'serial' | 'flash' | 'info' | 'camera'
  deviceLabel: string
  detail: string
  /** 烧录进度 0..1 */
  progress?: number
}

/** 界面状态（DeviceOverlay 读；改只经下面的 answerPrompt / stopActivity） */
export const deviceUi = reactive({ prompts: [] as DevicePrompt[], activity: [] as DeviceActivity[] })

const PROMPT_TIMEOUT_MS = 60_000
const CHANNEL_OPEN_TIMEOUT_MS = 15_000
const PROGRESS_INTERVAL_MS = 250

interface SerialEntry {
  session: SerialSession
  machineID: string
  port: SerialPort
  label: string
}

function failure(error: unknown, prefix: string): DeviceError {
  if (error instanceof DeviceError) return error
  return new DeviceError(RpcErrors.DeviceFailed, `${prefix}：${error instanceof Error ? error.message : String(error)}`)
}

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => (byte % 36).toString(36)).join('')
}

function waitOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('专用通道 15 秒没打开')), CHANNEL_OPEN_TIMEOUT_MS)
    channel.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    channel.addEventListener('close', () => {
      clearTimeout(timer)
      reject(new Error('专用通道被关了'))
    })
  })
}

class DeviceBroker {
  private hub: WorkChannelHub | null = null
  private machineName: (machineID: string) => string = (machineID) => machineID
  private readonly serialIds = new SerialIdRegistry<SerialPort>()
  private readonly sessions = new Map<string, SerialEntry>()
  /** 口 → 占着它的串口会话 id，或 'esp'（正在烧录 / 读芯片） */
  private readonly busy = new Map<SerialPort, string>()
  private readonly promptAnswers = new Map<number, (choice: PromptChoice) => void>()
  /** 请求 rid → 它在等的授权弹窗（请求被取消时一起撤） */
  private readonly promptOfRequest = new Map<number, number>()
  private readonly stoppers = new Map<string, () => void>()
  /** 发过 device.* 请求的机器（设备增减时通知它们） */
  private readonly machinesSeen = new Set<string>()
  private nextPromptId = 1

  attach(hub: WorkChannelHub, machineName: (machineID: string) => string): void {
    this.hub = hub
    this.machineName = machineName
    navigator.serial?.addEventListener('connect', () => this.devicesChanged())
    navigator.serial?.addEventListener('disconnect', (event) => {
      this.serialIds.forget(event.target as SerialPort)
      this.devicesChanged()
    })
    navigator.mediaDevices?.addEventListener('devicechange', () => this.devicesChanged())
  }

  handle(message: DevicePortMessage): void {
    if (message.type === 'device.request') void this.run(message)
    else if (message.type === 'device.cancel') {
      const promptId = this.promptOfRequest.get(message.rid)
      if (promptId !== undefined) this.promptAnswers.get(promptId)?.('deny')
    }
  }

  // MARK: 界面操作

  answerPrompt(id: number, choice: PromptChoice): void {
    this.promptAnswers.get(id)?.(choice)
  }

  stopActivity(key: string): void {
    this.stoppers.get(key)?.()
  }

  // MARK: 请求

  private async run(message: RequestMessage): Promise<void> {
    this.machinesSeen.add(message.machineID)
    try {
      const result = await this.dispatch(message)
      host.postDevice({ type: 'device.reply', rid: message.rid, ok: true, result: result ?? {} })
    } catch (error) {
      const deviceError = failure(error, '设备操作失败')
      host.postDevice({ type: 'device.reply', rid: message.rid, ok: false, code: deviceError.code, message: deviceError.message })
    } finally {
      this.promptOfRequest.delete(message.rid)
    }
  }

  private dispatch(message: RequestMessage): Promise<unknown> {
    switch (message.method) {
      case 'device.list':
        return this.list()
      case 'device.serial.open':
        return this.openSerial(message)
      case 'device.serial.close':
        return this.closeSerial(message)
      case 'device.esp.flash':
        return this.flash(message)
      case 'device.esp.info':
        return this.info(message)
      case 'device.camera.snapshot':
        return this.snapshot(message)
      default:
        return Promise.reject(new DeviceError(RpcErrors.MethodNotFound, `不认识的方法 ${message.method}`))
    }
  }

  private notify(machineID: string, method: string, params: unknown): void {
    host.postDevice({ type: 'device.notify', machineID, method, params })
  }

  private devicesChanged(): void {
    for (const machineID of this.machinesSeen) this.notify(machineID, 'device.changed', {})
  }

  // MARK: 设备清单

  private async serialPorts(): Promise<Array<{ port: SerialPort; info: SerialDeviceInfo }>> {
    if (!navigator.serial) return []
    const ports = await navigator.serial.getPorts()
    const names = await window.fridayBridge.serialPortNames().catch(() => [])
    const entries = ports.map((port) => {
      const { usbVendorId, usbProductId } = port.getInfo()
      return { port, id: this.serialIds.idFor(port, usbVendorId, usbProductId), usbVendorId, usbProductId }
    })
    const described = describePorts(entries, names)
    return entries.map((entry, index) => ({ port: entry.port, info: described[index] }))
  }

  private async list(): Promise<unknown> {
    const [serial, cameras] = await Promise.all([this.serialPorts(), listCameras().catch(() => [] as CameraDeviceInfo[])])
    return { devices: [...serial.map((entry) => entry.info), ...cameras] }
  }

  private async resolveSerial(deviceId: string): Promise<{ port: SerialPort; info: SerialDeviceInfo }> {
    const found = (await this.serialPorts()).find((entry) => entry.info.id === deviceId)
    if (!found) throw new DeviceError(RpcErrors.DeviceNotFound, `没有这个串口（${deviceId}），可能已经拔掉了`)
    return found
  }

  // MARK: 授权

  private async authorize(
    message: RequestMessage,
    capability: DeviceCapability,
    deviceId: string,
    deviceLabel: string,
    action: string
  ): Promise<void> {
    if (hasGrant(message.machineID, capability, deviceId)) return
    const machineName = this.machineName(message.machineID)
    const id = this.nextPromptId++
    const choice = await new Promise<PromptChoice>((resolve) => {
      const timer = setTimeout(() => finish('deny'), PROMPT_TIMEOUT_MS)
      const finish = (answer: PromptChoice): void => {
        clearTimeout(timer)
        this.promptAnswers.delete(id)
        const index = deviceUi.prompts.findIndex((prompt) => prompt.id === id)
        if (index >= 0) deviceUi.prompts.splice(index, 1)
        resolve(answer)
      }
      this.promptAnswers.set(id, finish)
      this.promptOfRequest.set(message.rid, id)
      deviceUi.prompts.push({ id, machineName, capability, deviceLabel, action, expiresAt: Date.now() + PROMPT_TIMEOUT_MS })
    })
    if (choice === 'deny') throw new DeviceError(RpcErrors.DeviceDenied, '客户端用户没有允许（或 60 秒内没人理）')
    if (choice === 'always') addGrant({ machineID: message.machineID, machineName, capability, deviceId, deviceLabel })
  }

  // MARK: 界面上的「正在用」

  private track(activity: DeviceActivity, stop?: () => void): void {
    deviceUi.activity.push(activity)
    if (stop) this.stoppers.set(activity.key, stop)
  }

  private untrack(key: string): void {
    const index = deviceUi.activity.findIndex((activity) => activity.key === key)
    if (index >= 0) deviceUi.activity.splice(index, 1)
    this.stoppers.delete(key)
  }

  private updateActivity(key: string, change: Partial<DeviceActivity>): void {
    const activity = deviceUi.activity.find((item) => item.key === key)
    if (activity) Object.assign(activity, change)
  }

  // MARK: 串口会话

  private async openSerial(message: RequestMessage): Promise<unknown> {
    const { deviceId, mode, config } = parseSerialOpen(message.params)
    const { port, info } = await this.resolveSerial(deviceId)
    const busyMessage = '这个串口已经被占用（开着别的会话或正在烧录）'
    if (this.busy.has(port)) throw new DeviceError(RpcErrors.DeviceBusy, busyMessage)
    const modeText = mode === 'rfc2217' ? 'RFC 2217' : '原始字节'
    await this.authorize(message, 'serial', deviceId, info.label, `打开串口（${modeText}，${config.baudRate} 波特）`)
    if (this.busy.has(port)) throw new DeviceError(RpcErrors.DeviceBusy, busyMessage)

    const sessionId = randomId()
    const label = `friday-serial:${sessionId}`
    const channel = this.hub?.openDataChannel(message.machineID, label)
    if (!channel) throw new DeviceError(RpcErrors.DeviceFailed, '和这台机器的工作通道还没通')
    this.busy.set(port, sessionId)
    const machineName = this.machineName(message.machineID)
    const detail = (): string => {
      const entry = this.sessions.get(sessionId)
      const config = entry?.session.config
      if (!config) return modeText
      return `${entry.session.suspended ? '烧录中，已暂停 · ' : ''}${config.baudRate} · ${modeText}`
    }
    const session = new SerialSession(port as unknown as PortLike, channel as unknown as ChannelLike, mode, config, {
      onClosed: (reason, byPeer) => {
        this.sessions.delete(sessionId)
        if (this.busy.get(port) === sessionId) this.busy.delete(port)
        this.untrack(sessionId)
        if (!byPeer) this.notify(message.machineID, 'device.serial.closed', { sessionId, reason })
      },
      onChange: () => this.updateActivity(sessionId, { detail: detail() })
    })
    try {
      await waitOpen(channel)
      await session.start()
    } catch (error) {
      this.busy.delete(port)
      try {
        channel.close()
      } catch {
        /* 已经关了 */
      }
      throw failure(error, '打开串口失败')
    }
    this.sessions.set(sessionId, { session, machineID: message.machineID, port, label: info.label })
    this.track(
      { key: sessionId, machineName, kind: 'serial', deviceLabel: info.label, detail: detail() },
      () => void session.close('客户端用户断开了')
    )
    return { sessionId, channel: label }
  }

  private async closeSerial(message: RequestMessage): Promise<unknown> {
    const sessionId = (message.params as { sessionId?: unknown } | null)?.sessionId
    const entry = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined
    if (!entry || entry.machineID !== message.machineID) {
      throw new DeviceError(RpcErrors.NotFound, '没有这个串口会话（可能已经关了）')
    }
    await entry.session.close('服务端关闭', true)
    return {}
  }

  // MARK: ESP 烧录 / 读芯片

  /** 独占一个口做 esptool-js 的事：开着串口会话就先挂起，做完恢复 */
  private async withExclusivePort<T>(machineID: string, port: SerialPort, work: () => Promise<T>): Promise<T> {
    const owner = this.busy.get(port)
    if (owner === 'esp') throw new DeviceError(RpcErrors.DeviceBusy, '这个口正在烧录')
    const entry = owner ? this.sessions.get(owner) : undefined
    if (entry && entry.machineID !== machineID) {
      throw new DeviceError(RpcErrors.DeviceBusy, '这个口被另一台机器的串口会话占着')
    }
    this.busy.set(port, 'esp')
    try {
      await entry?.session.suspend()
      return await work()
    } finally {
      if (entry && !entry.session.closed && owner) {
        this.busy.set(port, owner)
        await entry.session.resume()
      } else {
        this.busy.delete(port)
      }
    }
  }

  private async flash(message: RequestMessage): Promise<unknown> {
    const { deviceId, options } = parseFlash(message.params)
    const { port, info } = await this.resolveSerial(deviceId)
    const totalBytes = options.files.reduce((sum, file) => sum + file.data.length, 0)
    await this.authorize(
      message,
      'esp',
      deviceId,
      info.label,
      `烧录 ${options.files.length} 个文件（共 ${Math.ceil(totalBytes / 1024)} KB）${options.eraseAll ? '，先整片擦除' : ''}`
    )
    const key = `flash:${message.rid}`
    this.track({ key, machineName: this.machineName(message.machineID), kind: 'flash', deviceLabel: info.label, detail: '连接芯片…', progress: 0 })
    let lastProgress = 0
    try {
      return await this.withExclusivePort(message.machineID, port, () =>
        flashEsp(port, options, (fileIndex, written, total) => {
          const fraction = (fileIndex + (total > 0 ? written / total : 1)) / options.files.length
          this.updateActivity(key, { detail: `第 ${fileIndex + 1}/${options.files.length} 个文件`, progress: fraction })
          const now = Date.now()
          if (now - lastProgress < PROGRESS_INTERVAL_MS && written < total) return
          lastProgress = now
          this.notify(message.machineID, 'device.esp.progress', { requestId: message.serverID, fileIndex, written, total })
        })
      )
    } catch (error) {
      throw failure(error, '烧录失败')
    } finally {
      this.untrack(key)
    }
  }

  private async info(message: RequestMessage): Promise<unknown> {
    const { deviceId, before } = parseEspInfo(message.params)
    const { port, info } = await this.resolveSerial(deviceId)
    await this.authorize(message, 'esp', deviceId, info.label, '复位进下载模式读芯片信息（读完复位回应用）')
    const key = `info:${message.rid}`
    this.track({ key, machineName: this.machineName(message.machineID), kind: 'info', deviceLabel: info.label, detail: '读芯片信息…' })
    try {
      return await this.withExclusivePort(message.machineID, port, () => espInfo(port, before))
    } catch (error) {
      throw failure(error, '读芯片信息失败')
    } finally {
      this.untrack(key)
    }
  }

  // MARK: 摄像头

  private async snapshot(message: RequestMessage): Promise<unknown> {
    const { deviceId, options } = parseSnapshot(message.params)
    const cameras = await listCameras().catch(() => [] as CameraDeviceInfo[])
    let camera = deviceId ? cameras.find((item) => item.id === deviceId) : cameras[0]
    // 拿不到设备清单（权限还没给过）但只要默认摄像头：照样试
    if (!camera && !deviceId) camera = { id: `${CAMERA_PREFIX}default`, kind: 'camera', label: '默认摄像头' }
    if (!camera) throw new DeviceError(RpcErrors.DeviceNotFound, `没有这个摄像头（${deviceId}）`)
    await this.authorize(message, 'camera', camera.id, camera.label, '拍一张照片')
    const key = `camera:${message.rid}`
    this.track({ key, machineName: this.machineName(message.machineID), kind: 'camera', deviceLabel: camera.label, detail: '拍照中' })
    try {
      const browserId = camera.id === `${CAMERA_PREFIX}default` ? undefined : camera.id.slice(CAMERA_PREFIX.length)
      return await takeSnapshot({ ...options, deviceId: browserId })
    } catch (error) {
      throw failure(error, '拍照失败')
    } finally {
      this.untrack(key)
    }
  }
}

export const deviceBroker = new DeviceBroker()
