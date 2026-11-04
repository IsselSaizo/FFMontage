// Общая часть логики и панели: считает статистику по снимку проекта (ffm.project.get()).
export function stats(project) {
  const len = (c) => Math.max(0, (c.out - c.in) / (c.speed || 1));
  const video = project.videoClips || [];
  const audio = (project.audioTracks || []).flatMap((t) => t.clips || []);
  const end = [...video, ...audio].reduce((s, c) => Math.max(s, (c.start || 0) + len(c)), 0);
  return {
    videoClips: video.length,
    audioClips: audio.length,
    media: Object.values(project.media || {}).filter((m) => !m.hidden).length,
    duration: end,
  };
}

export const fmt = (s) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};
