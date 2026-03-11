/**
 * LoL 하이라이트 분석 프롬프트 설정
 * - REFERENCE_VIDEOS: Gemini가 자막 스타일을 참고할 유튜브 영상 URL 목록
 *   예) 'https://www.youtube.com/watch?v=VIDEO_ID'
 */
const REFERENCE_VIDEOS = [
  // 예시: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
];

const SUBTITLE_STYLE_GUIDE = `
자막 스타일 가이드 (매우 중요):
- 핵심 원칙: 실제 게임하는 사람이 혼잣말로 내뱉는 반응. 방송용 멘트 절대 금지.
- 길이: 1~5단어. 짧고 날 것의 반응.
- 톤: 유튜버 말투 X, 친구한테 하는 말투 O. 비속어/줄임말 자연스럽게 허용.
- 상황별 예시:
  · 잘 했을 때 (여유): "쉽죠?" / "이 정도야" / "당연하지" / "별거 아님"
  · 멀티킬 직전 빌드업: "잠깐, 이거..." / "어 다 있네" / "ㅋㅋ 다 죽어봐"
  · 멀티킬/펜타킬 확정: "야 ㅋㅋㅋ" / "미친" / "이게 되네" / "다 줘"
  · 어이없는 죽음: "시발" / "아 진짜" / "이게 왜 죽어" / "ㅋㅋ 어이없어"
  · 화려한 회피/생존: "ㅋㅋ 살았다" / "아슬아슬" / "이게 피냐" / "닿지도 않음"
  · 오브젝트 클러치: "내 거" / "먹었다" / "막타 각" / "바론 가자"
  · 팀파이트 캐리: "혼자 다 함" / "뭐하냐 얘네" / "내가 다 함"
  · 예상치 못한 상황: "어?" / "헐" / "뭐지" / "이거 맞아?"
- 절대 금지:
  · "쿼드라킬!", "펜타킬!", "트리플킬!", "퍼스트 블러드!" 같은 게임 앤카운서 멘트
  · 캐릭터 대사 그대로 옮기기
  · "여러분!", "보셨나요?", "대단하죠?" 같은 유튜버 멘트
  · 느낌표 남발, 이모지
- 이모지: 쓰지 마라`;

/**
 * Gemini에게 전달할 메인 분석 프롬프트
 * @param {number} duration - 영상 총 길이 (초)
 */
function buildPrompt(duration) {
  return `이 영상은 리그 오브 레전드(LoL) 게임 녹화 영상입니다 (총 ${Math.round(duration)}초, 약 ${Math.round(duration / 60)}분).

━━━━━━━━━━━━━━━━━━━━━━━━
분석 방법 — 반드시 준수
━━━━━━━━━━━━━━━━━━━━━━━━
소리는 완전히 무시하세요. 게임 내 앤카운서 효과음("Triple Kill!", "First Blood!" 등)을 분석 근거로 절대 사용하지 마세요.

오직 아래 시각적 요소로만 판단하세요:
- 화면 우측 상단 킬피드 (챔피언 아이콘 + 칼 아이콘 조합)
- 화면 중앙에 실제로 표시되는 킬 카운터 텍스트 (Double Kill, Triple Kill 등)
- 상대 챔피언의 사망 애니메이션 (그레이 처리, 쓰러짐)
- 체력바 소진 및 골드/경험치 획득 수치 변화
- 스코어보드 킬 카운트 변화

킬이 화면에 실제로 발생했는지 시각적으로 확인한 후에만 포함하세요. 소리만 들렸거나 확인이 안 되면 제외하세요.

━━━━━━━━━━━━━━━━━━━━━━━━
정확성 원칙
━━━━━━━━━━━━━━━━━━━━━━━━
- 없는 킬, 없는 멀티킬을 만들어내지 마세요.
- 제목과 내용이 반드시 일치해야 합니다. "트리플킬" 제목이면 영상에 트리플킬이 시각적으로 존재해야 합니다.
- 오브젝트만 먹고 끝나는 장면은 킬이 함께 없으면 단독 쇼츠로 만들지 마세요.
- 하이라이트가 없으면 빈 배열을 반환하세요. 억지로 채우지 마세요.
- 의심스러우면 제외하세요. 적게 뽑는 게 낫습니다.

━━━━━━━━━━━━━━━━━━━━━━━━
찾아야 할 장면 (중요도 순)
━━━━━━━━━━━━━━━━━━━━━━━━
1. 펜타킬 / 쿼드라킬 / 트리플킬 — 킬피드로 시각 확인 필수
2. 아웃플레이 — 체력 위험 상태에서 1vs2 이상 처치 또는 생존
3. 팀파이트 캐리 — 여러 킬을 혼자 처리하는 장면
4. 웃기거나 독특한 상황 (말도 안 되는 생존, 반전)
5. 오브젝트 + 킬이 함께 있는 클러치 장면

━━━━━━━━━━━━━━━━━━━━━━━━
멀티킬 클립 구성 규칙
━━━━━━━━━━━━━━━━━━━━━━━━
- 트리플킬/쿼드라킬/펜타킬: 반드시 첫 번째 킬 발생 5~8초 전부터 시작하세요 (빌드업 포함).
- 전체 구간이 60초 이내: standalone으로 첫 킬 전부터 마지막 킬+5초까지 전부 포함하세요.
- 전체 구간이 60초 초과: 핵심 킬 장면들만 잘라서 montage로 구성하되 합산 60초 이내.
- 빌드업 없이 갑자기 킬 장면으로 시작하지 마세요.

타입 구분:
- standalone: 한 연속 장면 (일반적인 경우)
- montage: 시간상 멀리 떨어진 장면들을 묶을 때만 사용

━━━━━━━━━━━━━━━━━━━━━━━━
${SUBTITLE_STYLE_GUIDE}

━━━━━━━━━━━━━━━━━━━━━━━━
출력 형식
━━━━━━━━━━━━━━━━━━━━━━━━
반드시 아래 JSON 형식 객체 하나만 반환하세요. 마크다운 코드블록(\`\`\`) 없이:
{
  "shorts": [
    {
      "type": "standalone",
      "title": "유튜브 쇼츠 제목 (한국어, 흥미롭고 클릭하고 싶게)",
      "startTime": 120,
      "endTime": 170,
      "description": "킬피드 기준 실제 발생 내용 설명",
      "virality": 9,
      "subtitles": [
        {"offsetSec": 0, "text": "잠깐만", "duration": 1.5},
        {"offsetSec": 28, "text": "미친", "duration": 2.5}
      ]
    },
    {
      "type": "montage",
      "title": "이번 판 멀티킬 모음 TOP3",
      "segments": [
        {"startTime": 200, "endTime": 218},
        {"startTime": 800, "endTime": 820},
        {"startTime": 1500, "endTime": 1518}
      ],
      "description": "3개 멀티킬 모음",
      "virality": 8,
      "subtitles": [
        {"offsetSec": 0, "text": "ㅋㅋ 다 있네", "duration": 2},
        {"offsetSec": 20, "text": "야", "duration": 2},
        {"offsetSec": 40, "text": "미친 거 아니야", "duration": 3}
      ]
    }
  ],
  "music": [
    {
      "title": "곡 제목 - 아티스트",
      "mood": "에너지틱, 승리감",
      "genre": "EDM",
      "source": "NCS (저작권 무료)",
      "searchQuery": "Elektronomia Sky High NCS"
    }
  ]
}

길이 규칙:
- standalone: endTime - startTime ≤ 60초 (펜타킬 특별한 경우만 최대 90초)
- montage: 모든 segments 합산 ≤ 60초

자막 규칙:
- offsetSec: 쇼츠 타임라인 기준 상대 시간 (0부터 시작)
- 각 쇼츠당 2~4개 자막
- 앤카운서 멘트, 캐릭터 대사 절대 금지

선정 규칙:
- 3~8개 쇼츠, virality 7점 이상만 포함
- virality: 1~10점 (10 = 유튜브에서 반드시 터질 장면)
- startTime / endTime: 초 단위 정수, 0 이상 ${Math.round(duration)} 이하
- 음악 3개 추천 (NCS, Artlist, Epidemic Sound 등 유튜브 저작권 무료 위주)`;
}

/**
 * Gemini API에 전달할 content 배열 생성
 * @param {object} geminiFile - 업로드된 메인 영상 파일 객체
 * @param {number} duration - 영상 총 길이 (초)
 * @param {{ referenceVideos?: string[], concept?: string }} [aiConfig]
 */
function buildContent(geminiFile, duration, aiConfig = {}) {
  const parts = [];

  const refVideos = (aiConfig.referenceVideos && aiConfig.referenceVideos.length > 0)
    ? aiConfig.referenceVideos
    : REFERENCE_VIDEOS;

  if (refVideos.length > 0) {
    parts.push({
      text: `다음 영상들은 자막 스타일과 편집 방식의 참고 예시입니다. ` +
            `이 영상들의 자막 길이, 표현, 타이밍 방식을 참고하여 분석해주세요.`
    });
    refVideos.forEach(url => {
      parts.push({ fileData: { fileUri: url } });
    });
    parts.push({ text: '---\n이제 분석할 실제 영상입니다:' });
  }

  parts.push({ fileData: { mimeType: geminiFile.mimeType, fileUri: geminiFile.uri } });

  const conceptNote = aiConfig.concept
    ? `\n\n추가 지침 (사용자 제공):\n${aiConfig.concept}`
    : '';
  parts.push({ text: buildPrompt(duration) + conceptNote });

  return parts;
}

module.exports = { buildContent, REFERENCE_VIDEOS };
