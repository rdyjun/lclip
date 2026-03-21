/**
 * 출력 필드 설명 및 선정 규칙
 * @param {number} duration - 영상 총 길이 (초)
 */
function buildOutputGuide(duration) {
  return `
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

선정 규칙:
- virality 점수 제한 없음 — 발견된 모든 유효한 장면을 포함하세요.
- 최대 10개 쇼츠
- startTime / endTime: 0 이상 ${Math.round(duration)} 이하 정수
- music: 3개 추천 (NCS, Artlist, Epidemic Sound 등 유튜브 저작권 무료 위주)
  각 항목: title(곡명-아티스트), mood, genre, source, searchQuery
- 제목이 해당 구간과 맞지 않으면 포함하지 마세요. 없는 게 낫습니다.`;
}

module.exports = { buildOutputGuide };
