#!/usr/bin/env python3
"""
라벨 JSON의 큰 정수 배열을 별도 BIN 파일로 분리한다.

  labels.json : "labels"(가우시안당 라벨 id) 배열  -> <stem>.labels.bin        (int16 LE)
  roi.json    : 각 ROI의 "Gaussian_Indices" 배열   -> <stem>.roi.<ROI_ID>.bin  (uint32 LE)

JSON 쪽에는 배열 대신 그 BIN 파일의 이름만 남는다. Object_Indices 는 그대로 둔다. 인덱스 기준(원본 PLY
행 번호), 값의 의미(-1 = 라벨 없음)는 그대로이고 바뀌는 것은 담는 그릇뿐이다.

사용법:
  python3 json-to-bin.py <파일.json> [...]      # 같은 폴더에 .bin + 새 .json 생성
  python3 json-to-bin.py --out <폴더> <파일.json> [...]
  python3 json-to-bin.py --check <파일.json>    # 변환본을 원본과 대조만
"""

import argparse
import array
import json
import os
import sys

LABEL_DTYPE = ('int16', 'h', 2)      # 라벨 id: 부재 수가 32,767을 넘을 일은 없다
INDEX_DTYPE = ('uint32', 'I', 4)     # 가우시안 인덱스: 원본 PLY 행 번호


def _stem(path):
    stem = os.path.basename(path).rsplit('.json', 1)[0]
    return stem.rsplit('.labels', 1)[0].rsplit('.roi', 1)[0]


def _write(path, values, fmt):
    a = array.array(fmt, values)
    if sys.byteorder != 'little':
        a.byteswap()
    with open(path, 'wb') as f:
        a.tofile(f)
    return path


def _read(path, fmt):
    a = array.array(fmt)
    with open(path, 'rb') as f:
        a.frombytes(f.read())
    if sys.byteorder != 'little':
        a.byteswap()
    return a


def convert_labels(doc, stem, out_dir):
    _, fmt, width = LABEL_DTYPE
    values = doc['labels']
    if not isinstance(values, list):
        raise SystemExit(f'{stem}: 이미 변환된 파일입니다')
    binname = f'{stem}.labels.bin'
    _write(os.path.join(out_dir, binname), values, fmt)
    doc['labels'] = binname          # 경로 문자열 하나만 남는다
    return [(binname, len(values) * width)]


def convert_roi(doc, stem, out_dir):
    _, fmt, width = INDEX_DTYPE
    written = []
    for roi in doc['ROIs']:
        idx = roi['Gaussian_Indices']
        if not isinstance(idx, list):
            raise SystemExit(f'{stem}: 이미 변환된 파일입니다')
        # ROI 하나당 파일 하나. 오프셋이 필요 없고, 하나 읽는 것이 곧 파일 하나를
        # 통째로 읽는 것이 된다. Object_Indices 는 JSON 에 그대로 둔다.
        binname = f"{stem}.roi.{roi['ROI_ID']}.bin"
        _write(os.path.join(out_dir, binname), idx, fmt)
        roi['Gaussian_Indices'] = binname
        written.append((binname, len(idx) * width))
    return written


def check(path, out_dir=None):
    """원본 JSON을 받아, 만들어진 BIN의 값이 한 개도 다르지 않은지 대조한다."""
    original = json.load(open(path, encoding='utf-8'))
    stem = _stem(path)
    folder = out_dir or os.path.dirname(os.path.abspath(path))

    if 'labels' in original:
        a = _read(os.path.join(folder, f'{stem}.labels.bin'), LABEL_DTYPE[1])
        assert list(a) == original['labels'], 'labels 불일치'
        print(f'  labels  {len(a):,}개 일치')
    if 'ROIs' in original:
        total = 0
        for roi in original['ROIs']:
            a = _read(os.path.join(folder, f"{stem}.roi.{roi['ROI_ID']}.bin"), INDEX_DTYPE[1])
            assert list(a) == roi['Gaussian_Indices'], f"{roi['Name']} 불일치"
            total += len(a)
            print(f"  ROI {roi['Name']:<6} {len(a):,}개 일치")
        print(f'  ROI 합계 {total:,}개 일치')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+')
    ap.add_argument('--out', default=None, help='출력 폴더 (기본: 입력 파일과 같은 폴더)')
    ap.add_argument('--check', action='store_true', help='변환하지 않고 대조만')
    args = ap.parse_args()

    for path in args.files:
        print(os.path.basename(path))
        if args.check:
            check(path, args.out and os.path.abspath(args.out))
            continue

        out_dir = args.out or os.path.dirname(os.path.abspath(path))
        os.makedirs(out_dir, exist_ok=True)
        doc = json.load(open(path, encoding='utf-8'))
        stem = _stem(path)

        if 'labels' in doc:
            written = convert_labels(doc, stem, out_dir)
            suffix = '.labels'
        elif 'ROIs' in doc:
            written = convert_roi(doc, stem, out_dir)
            suffix = '.roi'
        else:
            print('  건너뜀: labels도 ROIs도 없음')
            continue

        json_path = os.path.join(out_dir, f'{stem}{suffix}.json')
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
            f.write('\n')

        before = os.path.getsize(path)
        after = os.path.getsize(json_path) + sum(n for _, n in written)
        for binname, size in written:
            print(f'  {binname}  {size:,} bytes')
        print(f'  {os.path.basename(json_path)}  {os.path.getsize(json_path):,} bytes')
        print(f'  합계 {before:,} -> {after:,} bytes  ({before / after:.1f}배 작아짐)')


if __name__ == '__main__':
    main()
