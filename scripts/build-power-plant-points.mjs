/**
 * Geocoding progress + power plant CSV -> grouped point JSON
 *
 * 실행: node scripts/build-power-plant-points.mjs
 *
 * 기본 입력:
 * - constants/cleaned_power_plant_data.csv
 * - scripts/geocode-progress copy.json
 *
 * 기본 출력:
 * - constants/power-plant-points.json         지도/클러스터용 요약
 * - constants/power-plant-point-details.json 상세 조회용 원본 컬럼
 *
 * 출력 형태:
 * [
 *   {
 *     id,
 *     lat,
 *     lng,
 *     coordinates: [lng, lat],
 *     plantCount,
 *     addressCount,
 *     totalCapacityKw,
 *     addresses,
 *     firstPlantName
 *   }
 * ]
 */

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const CSV_PATH = path.join(ROOT, 'constants', 'cleaned_power_plant_data.csv')
const GEOCODE_PATH = path.join(ROOT, 'scripts', 'geocode-progress.json')
const SUMMARY_OUTPUT_PATH = path.join(ROOT, 'constants', 'power-plant-points.json')
const DETAILS_OUTPUT_PATH = path.join(ROOT, 'constants', 'power-plant-point-details.json')

function parseCsvLine(line) {
  const fields = []
  let cur = ''
  let inQuote = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"'
        i++
      } else {
        inQuote = !inQuote
      }
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

async function readCsv(filePath) {
  const rows = []
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  let headers = null
  for await (const line of rl) {
    const fields = parseCsvLine(line.replace(/^\uFEFF/, ''))
    if (!headers) {
      headers = fields.map((h) => h.trim())
      continue
    }
    if (fields.length < headers.length) continue

    const row = {}
    headers.forEach((h, i) => {
      row[h] = (fields[i] ?? '').trim()
    })
    rows.push(row)
  }

  return rows
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const num = Number(String(value).replaceAll(',', ''))
  return Number.isFinite(num) ? num : null
}

function coordinateKey(lng, lat) {
  return `${Number(lng).toFixed(7)},${Number(lat).toFixed(7)}`
}

function plantFromRow(row) {
  return {
    name: row['법인(상호)명'] || '',
    type: row['원동력의 종류'] || '',
    capacityKw: toNumber(row['설비용량(KW)']),
    region: row['기초'] || '',
    address: row['정제주소'] || '',
    originalAddress: row['설치장소(지번)'] || '',
    permitNo: row['기존인허가번호'] || '',
    permitDate: row['인허가일자'] || '',
    constructionReportDate: row['공사신고일'] || '',
    businessStartDate: row['사업개시일'] || '',
    preparationFrom: row['사업준비기간 from'] || '',
    preparationTo: row['사업준비기간 to'] || '',
  }
}

async function main() {
  const progress = JSON.parse(fs.readFileSync(GEOCODE_PATH, 'utf-8'))
  const geocoded = progress.results ?? {}
  const rows = await readCsv(CSV_PATH)
  const pointsByCoord = new Map()

  let matchedRows = 0
  let skippedRows = 0

  for (const row of rows) {
    const address = row['정제주소']
    const coord = address ? geocoded[address] : null
    if (!coord || !Number.isFinite(coord.lng) || !Number.isFinite(coord.lat)) {
      skippedRows++
      continue
    }

    matchedRows++
    const key = coordinateKey(coord.lng, coord.lat)
    const capacityKw = toNumber(row['설비용량(KW)']) ?? 0

    if (!pointsByCoord.has(key)) {
      pointsByCoord.set(key, {
        id: `power-plant-point-${pointsByCoord.size + 1}`,
        lat: coord.lat,
        lng: coord.lng,
        coordinates: [coord.lng, coord.lat],
        plantCount: 0,
        addressCount: 0,
        totalCapacityKw: 0,
        addresses: [],
        plants: [],
      })
    }

    const point = pointsByCoord.get(key)
    point.plantCount++
    point.totalCapacityKw += capacityKw
    if (!point.addresses.includes(address)) {
      point.addresses.push(address)
      point.addressCount = point.addresses.length
    }
    point.plants.push(plantFromRow(row))
  }

  const points = [...pointsByCoord.values()]
    .map((point) => ({
      ...point,
      totalCapacityKw: Number(point.totalCapacityKw.toFixed(3)),
    }))
    .sort((a, b) => b.plantCount - a.plantCount || b.totalCapacityKw - a.totalCapacityKw)

  const summaries = points.map(({ plants, ...point }) => ({
    ...point,
    firstPlantName: plants[0]?.name || '',
  }))
  const details = Object.fromEntries(points.map((point) => [point.id, point]))

  fs.mkdirSync(path.dirname(SUMMARY_OUTPUT_PATH), { recursive: true })
  fs.writeFileSync(SUMMARY_OUTPUT_PATH, JSON.stringify(summaries, null, 2))
  fs.writeFileSync(DETAILS_OUTPUT_PATH, JSON.stringify(details, null, 2))

  console.log(`CSV rows: ${rows.length}`)
  console.log(`Geocoded addresses: ${Object.keys(geocoded).length}`)
  console.log(`Matched plant rows: ${matchedRows}`)
  console.log(`Skipped plant rows: ${skippedRows}`)
  console.log(`Point groups: ${points.length}`)
  console.log(`Summary output: ${SUMMARY_OUTPUT_PATH}`)
  console.log(`Details output: ${DETAILS_OUTPUT_PATH}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
