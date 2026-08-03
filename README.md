# Paper AI Colleague

Zotero PDF 리더용 AI 동료 플러그인. 선택 **번역** · **설명** · **채팅** · **그림 설명**, 논문 단위 **RAG**, PDF 위 **sticky 메모**, 패널 **Markdown/KaTeX** 렌더.

## 기능

| 모드 | 동작 |
|------|------|
| **Translate** | 선택 텍스트 빠른 번역 (`fastTranslate` only, RAG 없음) |
| **Explain** | 선택 구간 + 논문 RAG 근거 설명 → sticky |
| **Chat** | 논문 전체 검색 기반 Q&A, 대화 영속 (`~/.paperai/chat/`) |
| **Figure** | Select Area / 이미지 주석 + 캡션·본문 근거 vision 설명 → sticky |

부가:

- 근거 라벨 `[§Body (n)]` 클릭 → PDF 페이지 점프
- sticky–선택 영역 **점선 연결** (영역 박스는 PDF page div 안)
- **노트 저장**: 마지막 답변 → Zotero note
- **진단 로그 복사**: 디버그 링버퍼 → 클립보드

## 인증

| Provider | 방법 |
|----------|------|
| **Grok** (권장, vision) | `grok login` → `~/.grok/auth.json` 또는 prefs API key |
| **OpenAI Codex** (텍스트) | `codex login` → `~/.codex/auth.json` |

```bash
grok login    # once
codex login   # optional
```

## 설치 (로컬 개발)

```bash
cd /path/to/zotero-plugins
npm install
npm run deploy:local   # build + profile XPI 복사
# Zotero 재시작
```

수동 설치: `.scaffold/build/paper-ai-colleague.xpi` → Tools → Plugins → Install from file.

Addon ID: `paper-ai@mqjinwon.github.io`

## 설정

**편집 → 설정 → Paper AI Colleague**

| 항목 | 의미 |
|------|------|
| **Target language** | 전역 출력 언어 (기본 `ko`). 모드별 없음 |
| Provider / model / reasoning | 전역 기본 + 모드별 override |
| Auto-translate on select | PDF 드래그 시 자동 번역 |

자세한 step-by-step: [docs/USAGE-KO.md](docs/USAGE-KO.md)

## 사용 (요약)

1. PDF를 **Zotero 내장 리더**로 연다  
2. 우측 Item pane **Paper AI**  
3. 본문 드래그 → 번역 / 설명  
4. Select Area 또는 이미지 주석 → 그림 설명  
5. 채팅 입력 · **이 논문 인덱싱** (없으면 첫 질문에 자동)

데이터 디렉터리:

```
~/.paperai/
  chat/{itemKey}.json
  sticky/{itemKey}.json
  rag/{itemKey}-{hash16}.json
```

## 개발

```bash
npm run build
npm run test:node      # auth + llm + rag + panel unit
npm run test:llm
npm run test:rag
npm run deploy:local
```

| 경로 | 역할 |
|------|------|
| `src/llm/` | prompts, fastTranslate, Grok/Codex clients |
| `src/rag/` | extract, chunk, BM25/hybrid, evidence footer |
| `src/ui/` | panel, sticky, reader events, markdown |
| `src/auth/` | CLI OAuth 재사용 |

에이전트/유지보수 규칙: [AGENTS.md](AGENTS.md) · 보안: [SECURITY.md](SECURITY.md)

## GitHub Release (XPI 공개)

Zotero 템플릿 관례: **XPI를 `main`에 커밋하지 않고**, 태그 기반 Actions가 Release에 올립니다.

```bash
# main 최신 + CI 그린 후
npm run release          # 버전 bump → tag vX.Y.Z push
# → .github/workflows/release.yml 이 build + publish
```

| 결과 | 설명 |
|------|------|
| Release `v1.2.3` | `*.xpi` + 릴리스 노트 |
| Release tag `release` | `update.json` / `update-beta.json` (자동 업데이트용) |

로컬 개발은 계속 `npm run deploy:local` (프로필 직접 설치). 상세 규칙은 [AGENTS.md](AGENTS.md#git--github-xpi-public-release).

## License

AGPL-3.0-or-later
