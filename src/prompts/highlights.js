const { SchemaType } = require('@google/generative-ai');

/**
 * LoL 하이라이트 분석 프롬프트 설정
 * - REFERENCE_VIDEOS: Gemini가 자막 스타일을 참고할 유튜브 영상 URL 목록
 *   예) 'https://www.youtube.com/watch?v=VIDEO_ID'
 */
const REFERENCE_VIDEOS = [
  // 예시: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
];

/**
 * Gemini structured output 스키마 — JSON 파싱 실패 방지 및 필드 타입 강제
 */
function buildResponseSchema() {
  const subtitle = {
    type: SchemaType.OBJECT,
    properties: {
      offsetSec: { type: SchemaType.NUMBER },
      text:      { type: SchemaType.STRING },
      duration:  { type: SchemaType.NUMBER },
    },
    required: ['offsetSec', 'text', 'duration'],
  };

  const segment = {
    type: SchemaType.OBJECT,
    properties: {
      startTime: { type: SchemaType.NUMBER },
      endTime:   { type: SchemaType.NUMBER },
    },
    required: ['startTime', 'endTime'],
  };

  const short = {
    type: SchemaType.OBJECT,
    properties: {
      type:        { type: SchemaType.STRING },
      title:       { type: SchemaType.STRING },
      description: { type: SchemaType.STRING },
      evidence:    { type: SchemaType.STRING },
      virality:    { type: SchemaType.NUMBER },
      startTime:   { type: SchemaType.NUMBER },
      endTime:     { type: SchemaType.NUMBER },
      segments:    { type: SchemaType.ARRAY, items: segment },
      subtitles:   { type: SchemaType.ARRAY, items: subtitle },
    },
    required: ['type', 'title', 'description', 'evidence', 'virality', 'subtitles'],
  };

  const music = {
    type: SchemaType.OBJECT,
    properties: {
      title:       { type: SchemaType.STRING },
      mood:        { type: SchemaType.STRING },
      genre:       { type: SchemaType.STRING },
      source:      { type: SchemaType.STRING },
      searchQuery: { type: SchemaType.STRING },
    },
    required: ['title', 'mood', 'genre', 'source', 'searchQuery'],
  };

  return {
    type: SchemaType.OBJECT,
    properties: {
      shorts: { type: SchemaType.ARRAY, items: short },
      music:  { type: SchemaType.ARRAY, items: music },
    },
    required: ['shorts', 'music'],
  };
}

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
분석 방법 — 오디오 + 시각 교차 검증
━━━━━━━━━━━━━━━━━━━━━━━━
오디오와 시각 정보를 교차 검증하여 판단하세요. 둘 중 하나만으로는 확정하지 마세요.

【1단계 — 오디오로 후보 구간 탐지】
아래 앤카운서 음성이 들리는 구간을 후보로 표시하세요:
- "Double Kill", "Triple Kill", "Quadra Kill", "Penta Kill" → 챔피언 멀티킬 후보
- "First Blood" → 첫 킬 후보
- "Ace!" → 상대팀 전멸 후보
- 팀원들의 환호/감탄 반응 → 팀파이트 후보

【2단계 — 시각으로 반드시 교차 확인】
오디오 후보 구간마다 아래 시각 요소로 실제 발생 여부를 검증하세요:
- 화면 우측 상단 킬피드 (챔피언 초상화 아이콘 + 칼 아이콘 + 챔피언 초상화 아이콘 조합)
- 화면 중앙 멀티킬 텍스트 (Double Kill, Triple Kill 등)
- 상대 챔피언 사망 애니메이션 (그레이 처리, 쓰러짐)
- 스코어보드 킬 카운트 변화

킬피드 아이콘 구별 (매우 중요):
- 챔피언 킬: 킬피드에 반드시 피해자의 챔피언 초상화(사각형 아이콘)가 보여야 합니다.
- 미니언 처치: 칼 아이콘만 나오거나 작은 미니언 아이콘. 챔피언 초상화 없음. → 킬 아님.
- 타워/오브젝트: 건물/용/바론 아이콘. 챔피언 초상화 없음. → 킬 아님.
- Double Kill/Triple Kill 텍스트는 챔피언 킬 연속 시에만 표시됩니다. 미니언을 아무리 먹어도 절대 뜨지 않습니다.

【판정 기준】
- 오디오 ✓ + 킬피드 시각 확인 ✓ → 킬 확정, 포함
- 오디오 ✓ + 킬피드 시각 불확실 → evidence에 "오디오 감지, 킬피드 확인 불가" 기록 후 제외
- 오디오 없음 + 킬피드 시각 확인 ✓ → 킬 확정, 포함 (오디오 없어도 시각 확인되면 유효)
- 오디오 없음 + 킬피드 불확실 → 제외

━━━━━━━━━━━━━━━━━━━━━━━━
정확성 원칙 (매우 중요 — 가장 많이 실수하는 부분)
━━━━━━━━━━━━━━━━━━━━━━━━
- 없는 킬, 없는 멀티킬을 만들어내지 마세요.
- 제목에 쓴 단어가 영상에서 실제로 일어났는지 반드시 확인하세요.
  예: "넥서스 파괴" → 넥서스가 실제로 폭발하는 장면이 해당 구간에 있어야 함.
  예: "트리플킬" → 킬피드에 3킬 아이콘이 실제로 보여야 함.
  예: "살아남음" → 죽지 않고 탈출하는 장면이어야 함.
- 도망치는 장면에 "넥서스 파괴", 지는 장면에 "아웃플레이" 같은 제목 절대 금지.
- 제목과 실제 구간의 내용이 맞지 않으면 그 쇼츠를 통째로 제외하세요.
- 오브젝트만 먹고 끝나는 장면은 킬이 함께 없으면 단독 쇼츠로 만들지 마세요.
- 하이라이트가 없으면 빈 배열을 반환하세요. 억지로 채우지 마세요.
- 의심스러우면 제외하세요. 적게 뽑는 게 낫습니다.
- description 필드에 킬피드에서 실제로 확인한 내용을 구체적으로 써주세요. "킬이 발생했음" 같은 모호한 설명 금지.

━━━━━━━━━━━━━━━━━━━━━━━━
찾아야 할 장면 (중요도 순)
━━━━━━━━━━━━━━━━━━━━━━━━
1. 펜타킬 / 쿼드라킬 / 트리플킬 — 킬피드로 시각 확인 필수
2. 아웃플레이 — 체력 위험 상태에서 1vs2 이상 처치 또는 생존
3. 팀파이트 캐리 — 여러 킬을 혼자 처리하는 장면
4. 자잘한 성과 모음 (montage) — 짧은 킬/어시스트 장면 여러 개를 묶어서 구성. 한 장면씩은 임팩트가 약해도 연속으로 보면 재밌는 장면들. 합산 60초 이내.
5. 어이없는 죽음 — "이건 살았다!" 싶었는데 갑자기 픽 죽는 순간. 반전 포인트가 있어야 함. 예: 도망가다 마지막 한 방에 픽, 스킬 쓰려고 했는데 CC에 걸려 사망, 체력 꽉 찬 상태에서 예상치 못한 암살. 단순히 싸우다 지는 장면은 해당 없음. 반드시 "되겠지?..." 싶었다가 "아 ㅋㅋ"하는 느낌이 있어야 함.
6. 오브젝트 + 킬이 함께 있는 클러치 장면

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
출력 필드 설명 (JSON 스키마 자동 적용됨)
━━━━━━━━━━━━━━━━━━━━━━━━
shorts 배열 각 항목:
- type: "standalone" (연속 장면) 또는 "montage" (분리된 장면 묶음)
- title: 한국어 유튜브 쇼츠 제목. 흥미롭고 클릭하고 싶게.
- evidence: 킬피드에서 눈으로 확인한 것을 그대로 나열. 예: "[32초] 킬피드에 카이사 초상화 확인. [38초] 킬피드에 아리 초상화 확인 → 더블킬 텍스트 표시." 챔피언 초상화를 확인 못 했으면 "확인 불가"라고 쓰고 해당 쇼츠를 제외하세요.
- description: 장면 전체 요약. evidence 기반으로 작성.
- virality: 1~10 (10 = 반드시 터질 장면)
- standalone: startTime, endTime 필드 (초 단위 정수)
- montage: segments 배열 ([{startTime, endTime}, ...])
- subtitles: [{offsetSec, text, duration}, ...] — offsetSec은 쇼츠 기준 상대 시간 (0부터)

길이 규칙:
- standalone: endTime - startTime ≤ 60초 (펜타킬 특별한 경우만 최대 90초)
- montage: 모든 segments 합산 ≤ 60초

자막 규칙:
- 각 쇼츠당 2~4개, offsetSec은 0부터 시작하는 상대 시간
- 앤카운서 멘트, 캐릭터 대사 절대 금지

선정 규칙:
- 1~8개 쇼츠, virality 6점 이상만 포함 (montage는 6점도 허용)
- startTime / endTime: 0 이상 ${Math.round(duration)} 이하 정수
- music: 3개 추천 (NCS, Artlist, Epidemic Sound 등 유튜브 저작권 무료 위주)
  각 항목: title(곡명-아티스트), mood, genre, source, searchQuery
- 제목이 해당 구간과 맞지 않으면 포함하지 마세요. 없는 게 낫습니다.`;
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

module.exports = { buildContent, buildResponseSchema, REFERENCE_VIDEOS };
