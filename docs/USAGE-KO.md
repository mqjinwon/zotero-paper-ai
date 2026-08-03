# Paper AI Colleague — 사용 가이드 (step by step)

## 0. 사전 준비 (한 번만)

### 0-1. 로그인 (구독 / CLI OAuth)

터미널에서:

```bash
# Grok (그림·수식 vision에 필요, 권장 기본 provider)
grok login

# 또는/추가로 ChatGPT 구독 텍스트용
codex login
```

토큰 파일:
- `~/.grok/auth.json`
- `~/.codex/auth.json`

### 0-2. 플러그인 설치

```bash
cd /home/jin/Documents/zotero-plugins
npm install
npm run build
```

1. Zotero 실행  
2. **도구(Tools) → 플러그인(Plugins)**  
3. 톱니바퀴 → **Install Plugin From File…**  
4. 선택:  
   ` /home/jin/Documents/zotero-plugins/.scaffold/build/paper-ai-colleague.xpi `  
5. Zotero 재시작 (권장)

### 0-3. 설정 확인

1. **편집 → 설정 → Paper AI** (또는 Preferences → Paper AI)  
2. **Provider**  
   - 기본: `Grok` (번역 + 그림/수식)  
   - 텍스트만 Codex 쓰려면 `OpenAI Codex`  
3. **Target language**: `ko`  
4. **Auto-translate when selecting text**: 체크 (기본 ON)  
5. **Test connection** → OK 확인  

API 키가 있으면 Grok API key에 넣어도 됨 (OAuth보다 우선).

---

## 1. 일상 읽기 흐름 (가장 자주 씀)

### 1-1. PDF 열기

1. Zotero 라이브러리에서 논문 더블클릭 (또는 PDF 첨부 열기)  
2. 오른쪽 **Item pane** 사이드에서 **Paper AI** 섹션 펼치기  

### 1-2. 문장 드래그 → 번역 (핵심)

1. PDF **내장 리더**로 연다 (외부 뷰어 X)  
2. 본문 영어를 **드래그 선택**  
3. Zotero 기본 **선택 팝업** 아래에 Paper AI 버튼이 붙음:  
   **번역 | 설명 | 수식 | 그림**  
4. Auto-translate ON이면 같은 팝업 안에 **번역 결과가 바로** 표시  
5. 우측 사이드바 **Paper AI** 아이콘을 누르면 전체 패널(채팅·노트 저장)  
6. PDF **상단 툴바**에 `Paper AI` 버튼도 있음  
7. 우클릭 메뉴: `Paper AI: 번역` 등  

> 자동 번역 OFF여도 팝업의 **번역** 버튼은 동작합니다.

### 1-3. 선택 후 더 깊게 읽기

| 하고 싶은 일 | 방법 |
|--------------|------|
| 번역 | 드래그 → 자동 / 플로팅 **번역** / 패널 **번역** |
| 개념 설명 | 드래그 → 플로팅 **설명** |
| 수식 이해 | 수식 근처 텍스트 드래그 또는 영역 → **수식** |
| 그림/그래프 이해 | 그림 근처 선택 또는 스냅샷 → **그림** |
| 자유 질문 | 패널 입력창 + **보내기** |

---

## 2. 그림 / 표 설명

1. Provider = **Grok**  
2. 그림이 보이는 페이지에서:  
   - 가능하면 그림 근처 텍스트를 살짝 선택하거나 페이지 영역이 캡처되게 한 뒤  
   - 플로팅 **그림** 또는 패널 **그림 설명**  
3. PDF 스냅샷이 안 되면 **이미지 파일 선택** 창이 뜸 → 스크린샷 PNG/JPG 지정  
4. 설명이 패널에 표시 (축, 범례, 핵심 메시지, 수식은 `$...$`)

---

## 3. 수식 설명

1. 수식이 **텍스트로 선택되면** 드래그 후 **수식**  
   - 글리프가 깨져도 “깨진 selection + (가능하면) 이미지”로 LaTeX 복원 시도  
2. 선택 안 되면 수식 부분 스크린샷 → **수식 설명** → 파일 선택  
3. 출력: LaTeX (`$$...$$`) + 기호 설명 + 의미 → 패널에서 KaTeX로 렌더  

---

## 4. Tools 메뉴

**도구 → Paper AI Colleague**

- Translate selection  
- Explain selection  
- Explain figure (vision)  
- Explain equation (vision)  

패널을 안 열었을 때도 동작 (ProgressWindow로 요약 표시).

---

## 5. 권장 설정 요약

| 항목 | 권장 |
|------|------|
| Provider | Grok |
| Target language | ko |
| Auto-translate | ON |
| Min chars | 8 (너무 짧으면 노이즈) |
| 그림/수식 | Grok only |

---

## 6. 문제 해결

| 증상 | 조치 |
|------|------|
| 드래그해도 반응 없음 | PDF 탭 포커스 확인, 플러그인 재설치/재시작, Paper AI 패널 한 번 열기 |
| `Run grok login` | 터미널 `grok login` 후 재시도 |
| 그림 설명 실패 (Codex) | Provider를 Grok으로 변경 |
| 자동 번역이 너무 잦음 | Auto-translate OFF 또는 Min chars 올리기 |
| 스냅샷 실패 | 화면 캡처 PNG 저장 → 그림/수식 클릭 시 파일 선택 |

---

## 7. 개발 재빌드 후 갱신

```bash
cd /home/jin/Documents/zotero-plugins
npm run build
# Zotero에서 동일 xpi 다시 설치 또는 dev serve
```

XPI 경로: `.scaffold/build/paper-ai-colleague.xpi`
