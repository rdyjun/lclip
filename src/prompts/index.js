const { buildResponseSchema } = require('./schema');
const { DETECTION_GUIDE }     = require('./detection');
const { ACCURACY_GUIDE }      = require('./accuracy');
const { SCENES_GUIDE }        = require('./scenes');
const { CLIPS_GUIDE }         = require('./clips');
const { buildOutputGuide }    = require('./output');

const REFERENCE_VIDEOS = [
  // 예시: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
];

function buildPrompt(duration) {
  return [
    `이 영상은 리그 오브 레전드(LoL) 게임 녹화 영상입니다 (총 ${Math.round(duration)}초, 약 ${Math.round(duration / 60)}분).`,
    DETECTION_GUIDE,
    ACCURACY_GUIDE,
    SCENES_GUIDE,
    CLIPS_GUIDE,
    buildOutputGuide(duration),
  ].join('\n');
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
    parts.push({ text: '다음 영상들은 편집 방식의 참고 예시입니다.' });
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
