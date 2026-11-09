// Diagnostic branch only: same app/projects; native fake microphone input.
import { defineConfig } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import config from './playwright.config.js'
const wav = resolve('test/native-microphone.wav')
const rate = 48000, seconds = 8, samples = rate * seconds
const bytes = Buffer.alloc(44 + samples * 2)
bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40)
let phase = 0
for (let i = 0; i < samples; i++) {
  const t = i / rate, pitch = 145 + 30 * Math.sin(2 * Math.PI * 2 * t)
  phase += 2 * Math.PI * pitch / rate
  let wave = 0
  for (let h = 1; h <= 8; h++) wave += Math.sin(h * phase) / h ** 1.4
  const envelope = 0.55 + 0.4 * Math.sin(2 * Math.PI * 4.5 * t)
  bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, wave * envelope * 0.35)) * 32767), 44 + i * 2)
}
writeFileSync(wav, bytes)
export default defineConfig({ ...config, projects: config.projects!.filter(project => ['chromium', 'chromium-desktop'].includes(project.name!)).map(project => ({ ...project, use: { ...project.use, launchOptions: { ...project.use?.launchOptions, args: [...(project.use?.launchOptions?.args ?? []), `--use-file-for-fake-audio-capture=${wav}`] } } })) })
