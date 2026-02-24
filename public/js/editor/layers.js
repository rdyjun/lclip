/**
 * Layers Panel - manages layer creation and UI in the toolbar
 */
const Layers = (() => {

  function init() {
    document.getElementById('btn-add-subtitle').addEventListener('click', addSubtitleLayer);
    document.getElementById('btn-add-audio').addEventListener('click', openAudioModal);

    EditorState.on('projectLoaded', renderLayersList);
    EditorState.on('layersChanged', renderLayersList);
  }

  function renderLayersList() {
    // Layer list is rendered by Timeline.renderLabels()
    Timeline.renderLabels();
  }

  function addSubtitleLayer() {
    const project = EditorState.getProject();
    if (!project) return;

    EditorState.saveSnapshot();
    const layerCount = project.layers.filter(l => l.type === 'subtitle').length;
    const t = EditorState.getCurrentTime();

    EditorState.addLayer({
      id: EditorState.genId(),
      type: 'subtitle',
      name: `자막 레이어 ${layerCount + 1}`,
      order: project.layers.length,
      locked: false,
      visible: true,
      clips: [
        {
          id: EditorState.genId(),
          type: 'subtitle',
          text: '새 자막',
          startTime: t,
          endTime: t + 3,
          x: 540,
          y: 300,
          fontSize: 56,
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
        }
      ]
    });
  }

  function openAudioModal() {
    document.getElementById('modal-audio').style.display = 'flex';
  }

  function addAudioLayer(audioPath, audioName, startTime, volume, audioDuration) {
    const project = EditorState.getProject();
    if (!project) return;

    EditorState.saveSnapshot();
    // Find or create audio layer
    let audioLayer = project.layers.find(l => l.type === 'audio');

    const clip = {
      id: EditorState.genId(),
      type: 'audio',
      src: audioPath,
      name: audioName,
      startTime: startTime,
      endTime: startTime + (audioDuration || 60),
      volume: volume / 100
    };

    if (audioLayer) {
      EditorState.addClip(audioLayer.id, clip);
    } else {
      EditorState.addLayer({
        id: EditorState.genId(),
        type: 'audio',
        name: '배경음악',
        order: project.layers.length,
        locked: false,
        visible: true,
        clips: [clip]
      });
    }
  }

  return { init, addSubtitleLayer, addAudioLayer };
})();
