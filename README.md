# Pinfall Lab

Box2D 3 WASM, Web Worker, TypeScript, PixiJS로 만든 2D 물리 기반 빠칭코 프로토타입입니다.

## 가장 쉬운 실행

Windows에서는 [Run_Pinfall_Lab.cmd](Run_Pinfall_Lab.cmd)를 더블클릭하세요. 로컬 서버를 자동으로 시작하고 기본 브라우저에서 게임을 엽니다. `pnpm` 명령은 필요하지 않습니다. CMD의 호환성을 위해 실행 중 표시되는 문구는 영어로 되어 있습니다.

코드를 수정한 뒤 다시 실행할 때는 기존 `Pinfall Lab Server` 창을 먼저 닫고 실행하세요. 실행 파일은 Vite의 브라우저 의존성 캐시를 새로 만들어 이전 코드의 조각을 참조하지 않게 합니다.

Box2D WASM과 Web Worker는 브라우저 보안 정책상 HTML 파일을 직접 더블클릭한 `file://` 환경에서는 로드할 수 없습니다. 따라서 이 실행 파일이 필요한 최소한의 `localhost` 서버를 대신 실행합니다.

## 개발 실행

```powershell
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173
```

브라우저에서 Vite가 표시한 주소를 엽니다. 배포용 검증은 `pnpm run build`로 수행합니다.

## 조작

- 상점에서 핀을 구매합니다. 구매 핀은 필드에서 드래그해 준비 단계에 무료 배치합니다.
- 필드 위 휠로 발사대 각도를 조절합니다.
- 경사/회전 핀을 선택하면 우측 패널에서 물리값, 설치 각도, 업그레이드를 조절합니다.
- 투입할 볼 수를 정하고 라운드를 시작합니다.

## 설정

초기 밸런스 값은 `public/config/*.csv`에 있으며, 새 게임을 새로고침하면 반영됩니다.

- `balls.csv`: 공통 볼 물리값
- `pins.csv`: 핀 구매 비용 및 기본값
- `pin_upgrades.csv`: 개별 핀 레벨별 비용과 허용 범위
- `slots.csv`: 하단 칸 보상·손실 종류
- `game_rules.csv`: 필드 크기, 고정 스텝, 초기 볼 수

현재 CSV 형식은 쉼표를 데이터에 포함하지 않는 엄격한 단순 형식이다. 값은 숫자·필수 컬럼·범위 역전 여부를 로딩 때 확인한다.

## 구조

```text
web/src/main.ts                  UI, PixiJS 렌더링, 입력
web/src/worker/physics.worker.ts Worker 권위 상태, Box2D 월드, 경제·정산
web/src/config.ts                CSV 로드·검증
public/config/                   수정 가능한 초기 밸런스
```

물리 계산은 Worker 안의 Box2D 3 WASM 월드가 담당한다. 메인 스레드는 물리 상태를 직접 변경하지 않고 명령과 스냅샷만 교환한다. 이 프로토타입은 `box2d3-wasm`의 사전 컴파일된 Box2D 3 C API 호환 빌드를 사용한다.

## 과제 기록에 포함할 것

1. Box2D 예제 3개 이상을 실행하고 바꾼 수치와 관찰 결과를 기록한다.
2. 충돌 감지, 반발계수, 마찰, 회전 관절·모터의 작동을 캡처와 함께 설명한다.
3. `THIRD_PARTY_NOTICES.md`의 원본 의존성과 본인 작성 코드 범위를 구분해 제출 자료에 표시한다.
4. 30~60초 시연 영상과 3~5쪽 설명 PDF에 입력·변경점·막힌 점·AI 사용 내역을 정리한다.
