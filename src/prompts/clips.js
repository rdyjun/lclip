/**
 * 클립 구성 규칙 — standalone / montage 타입 분기
 */
const CLIPS_GUIDE = `
━━━━━━━━━━━━━━━━━━━━━━━━
클립 구성 규칙
━━━━━━━━━━━━━━━━━━━━━━━━
- 트리플킬/쿼드라킬/펜타킬: 반드시 첫 번째 킬 발생 5~8초 전부터 시작하세요 (빌드업 포함).
- 전체 구간이 60초 이내: standalone으로 첫 킬 전부터 마지막 킬+5초까지 전부 포함하세요.
- 전체 구간이 60초 초과: 핵심 킬 장면들만 잘라서 montage로 구성하되 합산 60초 이내.
- 빌드업 없이 갑자기 킬 장면으로 시작하지 마세요.

타입 구분:
- standalone: 한 연속 장면 (startTime, endTime 사용)
- montage: 시간상 멀리 떨어진 장면들을 묶을 때 (segments 배열 사용)

길이 규칙:
- standalone: endTime - startTime ≤ 60초 (펜타킬 특별한 경우만 최대 90초)
- montage: 모든 segments 합산 ≤ 60초`;

module.exports = { CLIPS_GUIDE };
