#!/usr/bin/env python3
"""
지번 txt 파일 → SQLite 변환 스크립트

두 가지 입력 포맷 지원:
  전라남도_나주시_경현동__10 | [{'DL_NM': '동신', ...}]          # 상수 키
  전라남도_영암군_군서면_가사리_110-1 | [{'dlNm': '동호', ...}]  # 카멜 키

출력 테이블:
  parcel(sido, sgg, emd, ri, jibun, dl_nms)
  dl_nms: JSON 배열 문자열  예) '["동신", "내리"]'

사용법:
  python convert_parcel.py <데이터폴더> <출력.db>
  python convert_parcel.py ./raw_data ../wire_finder_map/data/parcel.db
"""

import ast
import json
import sqlite3
import sys
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS parcel (
  sido   TEXT NOT NULL,
  sgg    TEXT NOT NULL,
  emd    TEXT NOT NULL,
  ri     TEXT NOT NULL,
  jibun  TEXT NOT NULL,
  dl_nms TEXT NOT NULL,
  PRIMARY KEY (sido, sgg, emd, ri, jibun)
);
CREATE INDEX IF NOT EXISTS idx_addr ON parcel(sido, sgg, emd, ri, jibun);
"""


def parse_address(addr: str) -> tuple[str, str, str, str, str]:
    """
    주소 문자열 → (sido, sgg, emd, ri, jibun)

    전라남도_나주시_경현동__10       → ('전라남도', '나주시', '경현동', '',      '10')
    전라남도_영암군_군서면_가사리_110-1 → ('전라남도', '영암군', '군서면', '가사리', '110-1')
    """
    parts = addr.strip().split("_")
    if len(parts) >= 5:
        # 지번에 _ 가 포함될 경우 대비해 나머지를 다시 합침
        return parts[0], parts[1], parts[2], parts[3], "_".join(parts[4:])
    if len(parts) == 4:
        # ri 없음 (경현동__10 → split 결과 ['경현동', '', '10'] 의 앞부분)
        return parts[0], parts[1], parts[2], "", parts[3]
    return "", "", "", "", addr


def parse_dl_nms(record_str: str) -> list[str]:
    """
    파이썬 리터럴 배열에서 DL_NM / dlNm 값만 수집 (중복 제거, 순서 유지)
    """
    try:
        records = ast.literal_eval(record_str.strip())
        seen: set[str] = set()
        names: list[str] = []
        for r in records:
            val = r.get("DL_NM") or r.get("dlNm") or ""
            if val and val not in seen:
                seen.add(val)
                names.append(val)
        return names
    except Exception:
        return []


def open_file(path: Path):
    for enc in ("utf-8", "cp949"):
        try:
            return open(path, "r", encoding=enc)
        except UnicodeDecodeError:
            continue
    return None


def convert(base_path: str, db_path: str) -> None:
    base_dir = Path(base_path)
    if not base_dir.is_dir():
        print(f"[-] 폴더를 찾을 수 없습니다: {base_path}")
        sys.exit(1)

    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    cur = conn.cursor()

    txt_files = sorted(base_dir.rglob("*.txt"))
    print(f"[*] 기준 폴더 : {base_dir.resolve()}")
    print(f"[*] 파일 수   : {len(txt_files):,} 개")
    print(f"[*] 출력 DB   : {Path(db_path).resolve()}")
    print("-" * 60)

    total_rows = 0
    total_skip = 0

    for file_path in txt_files:
        f = open_file(file_path)
        if f is None:
            print(f"[Skip] 읽기 실패: {file_path.relative_to(base_dir)}")
            continue

        rows: list[tuple] = []
        skip = 0
        with f:
            for line in f:
                line = line.strip()
                if not line or " | " not in line:
                    skip += 1
                    continue

                addr_str, record_str = line.split(" | ", 1)
                sido, sgg, emd, ri, jibun = parse_address(addr_str)
                dl_nms = parse_dl_nms(record_str)

                if not jibun or not dl_nms:
                    skip += 1
                    continue

                rows.append((sido, sgg, emd, ri, jibun, json.dumps(dl_nms, ensure_ascii=False)))

        cur.executemany(
            "INSERT OR REPLACE INTO parcel(sido, sgg, emd, ri, jibun, dl_nms) VALUES (?,?,?,?,?,?)",
            rows,
        )
        conn.commit()

        total_rows += len(rows)
        total_skip += skip
        print(f"{file_path.relative_to(base_dir)}: {len(rows):,} rows (skip {skip})")

    conn.close()
    print("-" * 60)
    print(f"총 삽입 행 : {total_rows:,}")
    print(f"총 스킵 행 : {total_skip:,}")
    print(f"[완료] → {db_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python convert_parcel.py <데이터폴더> <출력.db>")
        print("  예 : python convert_parcel.py ./raw_data parcel.db")
        sys.exit(1)

    convert(sys.argv[1], sys.argv[2])
