/**
 * Naver Geocoding 배치 스크립트
 *
 * 실행: node scripts/geocode.mjs
 *
 * - 중단 후 재실행 시 기존 진행분 자동 스킵
 * - 500건마다 진행상황 저장
 * - 완료 후 public/data/power-plants.geojson 생성
 */

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ── 설정 ──────────────────────────────────────────────────────────
const CSV_PATH = path.join(ROOT, 'constants', 'cleaned_power_plant_data.csv')
const PROGRESS_PATH = path.join(ROOT, 'scripts', 'geocode-progress.json')
const OUTPUT_PATH = path.join(ROOT, 'public', 'data', 'power-plants.geojson')
const FAILED_PATH = path.join(ROOT, 'scripts', 'geocode-failed.json')

const GEOCODE_URL = 'https://maps.apigw.ntruss.com/map-geocode/v2/geocode'
const DELAY_MS = 110        // ~9 req/s (안전 마진)
const SAVE_EVERY = 500      // N건마다 중간 저장
// ──────────────────────────────────────────────────────────────────

// .env.local 파싱
function loadEnv() {
  const envPath = path.join(ROOT, '.env.local')
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n')
  const env = {}
  for (const line of lines) {
    const [key, ...rest] = line.split('=')
    if (key && rest.length) env[key.trim()] = rest.join('=').trim()
  }
  return env
}

// CSV 한 줄을 필드 배열로 파싱 (quoted field 처리)
function parseCsvLine(line) {
  const fields = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++ }
      else inQuote = !inQuote
    } else if (ch === ',' && !inQuote) {
      fields.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  fields.push(cur)
  return fields
}

// CSV 전체 읽기
async function readCsv(filePath) {
  const rows = []
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  let headers = null
  for await (const line of rl) {
    const fields = parseCsvLine(line.replace(/^﻿/, '')) // BOM 제거
    if (!headers) { headers = fields; continue }
    if (fields.length < headers.length) continue

    const row = {}
    headers.forEach((h, i) => { row[h.trim()] = (fields[i] || '').trim() })
    rows.push(row)
  }
  return rows
}

// Naver 지오코딩 API 호출
async function geocode(address, clientId, clientSecret) {
  const url = `${GEOCODE_URL}?query=${encodeURIComponent(address)}`
  const res = await fetch(url, {
    headers: {
      'X-NCP-APIGW-API-KEY-ID': clientId,
      'X-NCP-APIGW-API-KEY': clientSecret,
      'Accept': 'application/json',
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`HTTP ${res.status}: ${body}`)
  }
  const data = await res.json()
  if (data.addresses && data.addresses.length > 0) {
    const { x, y } = data.addresses[0]  // x=lng, y=lat
    return { lng: parseFloat(x), lat: parseFloat(y) }
  }
  return null
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 진행상황 저장
function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2))
}

// GeoJSON 생성 및 저장
function writeGeoJson(rows, progress) {
  const features = []
  for (const row of rows) {
    const addr = row['정제주소']
    const result = progress.results[addr]
    if (!result) continue

    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [result.lng, result.lat],
      },
      properties: {
        name: row['법인(상호)명'],
        type: row['원동력의 종류'],
        capacity: parseFloat(row['설비용량(KW)']) || null,
        region: row['기초'],
        address: addr,
      },
    })
  }

  const geojson = {
    type: 'FeatureCollection',
    features,
  }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(geojson))
  return features.length
}

// ── 메인 ──────────────────────────────────────────────────────────
async function main() {
  const env = loadEnv()
  const clientId = env['GEOCODING_CLIENT_ID']
  const clientSecret = env['GEOCODING_CLIENT_SECRET']

  if (!clientId || !clientSecret) {
    console.error('❌ .env.local에 GEOCODING_CLIENT_ID, GEOCODING_CLIENT_SECRET 필요')
    process.exit(1)
  }

  console.log('📂 CSV 읽는 중...')
  const rows = await readCsv(CSV_PATH)
  console.log(`✅ 총 ${rows.length}건 로드`)

  // 중단 후 재시작 지원
  let progress = { results: {}, failed: [] }
  if (fs.existsSync(PROGRESS_PATH)) {
    progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'))
    const done = Object.keys(progress.results).length
    console.log(`🔄 기존 진행분 ${done}건 로드 (이어서 시작)`)
  }

  const targets = rows.filter(r => {
    const addr = r['정제주소']
    return addr && !progress.results[addr]
  })

  // 이미 처리된 주소 중복 제거 (같은 주소 여러 행)
  const uniqueTargets = []
  const seenAddr = new Set()
  for (const row of targets) {
    const addr = row['정제주소']
    if (!seenAddr.has(addr)) {
      seenAddr.add(addr)
      uniqueTargets.push(row)
    }
  }

  console.log(`📍 지오코딩 대상: ${uniqueTargets.length}건 (예상 소요: ~${Math.ceil(uniqueTargets.length * DELAY_MS / 60000)}분)`)

  let done = 0
  for (const row of uniqueTargets) {
    const addr = row['정제주소']
    try {
      const result = await geocode(addr, clientId, clientSecret)
      if (result) {
        progress.results[addr] = result
      } else {
        progress.failed.push(addr)
        console.warn(`  ⚠️  결과 없음: ${addr}`)
      }
    } catch (err) {
      progress.failed.push(addr)
      console.error(`  ❌ 오류 [${addr}]: ${err.message}`)
    }

    done++
    if (done % SAVE_EVERY === 0) {
      saveProgress(progress)
      const total = Object.keys(progress.results).length
      console.log(`💾 저장 (${done}/${uniqueTargets.length}) — 성공 ${total}건, 실패 ${progress.failed.length}건`)
    }

    await sleep(DELAY_MS)
  }

  // 최종 저장
  saveProgress(progress)
  fs.writeFileSync(FAILED_PATH, JSON.stringify(progress.failed, null, 2))

  console.log('\n✨ 지오코딩 완료!')
  console.log(`   성공: ${Object.keys(progress.results).length}건`)
  console.log(`   실패: ${progress.failed.length}건 → ${FAILED_PATH}`)

  const count = writeGeoJson(rows, progress)
  console.log(`\n📄 GeoJSON 저장 완료: ${OUTPUT_PATH}`)
  console.log(`   포함된 Feature 수: ${count}건`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
