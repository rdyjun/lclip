/**
 * 프로젝트 초기값 — 서버/클라이언트 공용 단일 소스
 * 서버: require('./src/config/defaults')
 * 브라우저: window.APP_DEFAULTS  (GET /api/defaults.js 로 주입)
 */
module.exports = {
  video: {
    x: 0,
    y: 420,
    width: 1080,
    height: 1080,
    scale: 1,
    opacity: 1
  },
  subtitle: {
    fontSize: 80,
    fontFamily: 'Noto Sans KR, sans-serif',
    color: '#ffffff',
    backgroundColor: 'rgba(0,0,0,0.6)',
    backgroundPadding: 16,
    borderRadius: 8,
    align: 'center',
    bold: true,
    italic: false,
    shadow: '2px 2px 4px rgba(0,0,0,0.8)',
    outline: '2px solid rgba(0,0,0,0.9)'
  },
  channelSubtitle: {
    x: 540,
    y: 1780,
    fontSize: 36,
    fontFamily: 'Noto Sans KR, sans-serif',
    color: '#ffffff',
    backgroundColor: 'rgba(0,0,0,0.4)',
    backgroundPadding: 12,
    borderRadius: 6,
    align: 'center',
    bold: false,
    italic: false,
    shadow: '1px 1px 3px rgba(0,0,0,0.8)',
    outline: 'none'
  }
};
