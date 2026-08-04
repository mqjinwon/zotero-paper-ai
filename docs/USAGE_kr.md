# Paper AI Colleague — 사용 가이드 (한국어)

## 1. 한 번만 하는 준비

### 인증

```bash
grok login    # 권장 (그림·vision)
codex login   # 선택 (ChatGPT 텍스트)
```

파일: `~/.grok/auth.json`, `~/.codex/auth.json`  
또는 **편집 → 설정 → Paper AI Colleague** 에서 Grok API 키.

### 설치

- **릴리스:** `paper-ai-colleague-vX.Y.Z.xpi` 다운로드 → 도구 → 플러그인 → 파일에서 설치 → 재시작.
- **개발:** `npm install && npm run deploy:local` → Zotero 재시작.

## 2. 패널 열기

1. PDF를 Zotero **내장 리더**로 연다 (외부 뷰어 X).
2. 해당 논문 항목/PDF 탭 포커스.
3. 우측 항목 창 → **Paper AI** 섹션.

## 3. 일상 사용

### 번역 / 설명 (PDF 위)

1. 본문 드래그 선택.
2. 팝업에서 **Translate** / **Explain**.
3. 설명은 PDF 위 **sticky** (드래그, `—` 접기, `×` 닫기).

### 그림

1. Select Area / 이미지 주석.
2. **Figure explain**.
3. **Grok** 등 vision 가능 설정 필요.

### 논문 요약 (패널 상단)

1. **요약 생성하기**.
2. 3–5개 bullet (RAG 근거).
3. child note 태그 `paper-ai-summary` → **라이브러리 동기화**.

### 자동 하이라이트

1. PDF를 스크롤해 페이지·텍스트 레이어가 뜨게 함.
2. **생성하기**.
3. 기본 4분류:

| 분류 | 기본 스타일 | 의미 |
| ---- | ----------- | ---- |
| 주장·결과 | 노랑 하이라이트 | 핵심 claim / 결과 |
| 방법·정의 | 파랑 밑줄 | 절차·정의 |
| 기여·새로움 | 초록 하이라이트 | contribution |
| 한계·가정 | 분홍 밑줄 | limitation |

4. 목록: **이동** / **삭제** · **전체 삭제** (`paper-ai-auto`만).
5. 설정에서 개수·색·하이라이트/밑줄 변경 가능.

색을 바꾼 뒤에는 **전체 삭제 → 다시 생성**해야 새 색이 반영됩니다.

### 채팅

1. 질문 입력 → **보내기** (Enter / Shift+Enter 줄바꿈).
2. 답의 `[§Introduction ¶2 s3]` 클릭 → PDF 점프.
3. 대화는 `paper-ai-chat` note로 저장 (근거 목록 dump 없음).
4. **대화 지우기** = 이 논문 저장본까지 삭제.

### PDF 메모 오버레이

| 버튼 | 동작 |
| ---- | ---- |
| PDF에서 숨기기 | 카드·연결선 숨김, 목록 유지 |
| PDF에 보이기 | 다시 표시 |
| 모두 접기/펼치기 | 접기만 |
| 목록 항목 클릭 | 오버레이 표시 + 해당 메모 포커스 |

### 인덱싱 (RAG)

- **이 논문 인덱싱** → 로컬 BM25 캐시 (`dataDir/rag`).
- 채팅·요약·자동 HL 첫 실행 시 자동 인덱싱될 수 있음.
- 캐시는 **기기 로컬** (재생성 비용 작음).

## 4. 설정 요약

**편집 → 설정 → Paper AI Colleague**

- **Data directory:** 비우면 `{Zotero data dir}/paperai` (주로 RAG).
- **Target language:** 출력 언어.
- Provider / model / reasoning (전역 + 기능별).
- **자동 하이라이트:** 전체·카테고리당 개수, 색, 스타일.
- **RAG:** 기본 BM25, 선택적 embeddings.

## 5. 동기화

- 노트·PDF 주석 → **Zotero 라이브러리 Sync**.
- RAG 폴더 → WebDAV File Sync 대상 아님.
- OAuth/API 키는 라이브러리에 넣지 않음.

## 6. 문제 해결

| 증상 | 대응 |
| ---- | ---- |
| 패널 비어 있음 | 재시작, 플러그인 활성 확인 |
| 인덱싱/추출 실패 | PDF 탭 포커스, 텍스트 레이어 있는 PDF |
| 자동 HL 위치 이상 | 전체 삭제 → 페이지 스크롤 → 재생성 |
| 저장 실패 (key) | annotation `key` 넣는 최신 빌드 |
| 그림 안 됨 | Grok 로그인/키 |
| 디버그 | **진단 로그 복사** |

## 7. 태그

| 태그 | 용도 |
| ---- | ---- |
| `paper-ai-chat` | 채팅 기록 |
| `paper-ai-sticky` | sticky JSON |
| `paper-ai-summary` | 요약 |
| `paper-ai-auto` | 자동 하이라이트 |
| `paper-ai-auto/{claim\|method\|novelty\|caveat}` | 분류 |

**전체 삭제**는 위 auto 태그만 지웁니다. 수동 하이라이트는 유지됩니다.
