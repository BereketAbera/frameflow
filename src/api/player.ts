export function playerHtml(videoId: string): string {
  const safeId = JSON.stringify(videoId).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Video ${videoId}</title>
<style>body{font:16px system-ui;max-width:960px;margin:3rem auto;padding:0 1rem;background:#111;color:#eee}video{width:100%;background:#000;margin-top:1rem}#status{padding:.75rem;background:#222;border-radius:.4rem}.error{color:#ff9d9d}</style>
</head><body><h1>Video playback</h1><div id="status">Loading status…</div><video id="video" controls hidden></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script><script>
const id=${safeId}, statusEl=document.querySelector('#status'), video=document.querySelector('#video');
let timer;
function play(url){video.hidden=false;if(video.canPlayType('application/vnd.apple.mpegurl')){video.src=url;return}
if(window.Hls&&Hls.isSupported()){const hls=new Hls();hls.loadSource(url);hls.attachMedia(video);hls.on(Hls.Events.ERROR,(_,d)=>{if(d.fatal)statusEl.textContent='Playback failed.'});return}
statusEl.textContent='HLS playback is unavailable in this browser.'}
async function refresh(){try{const response=await fetch('/videos/'+encodeURIComponent(id));const data=await response.json();
if(!response.ok)throw new Error(data.error?.message||'Status request failed');
if(data.status==='completed'){statusEl.textContent='Processing completed.';play(data.playbackUrl);return}
if(data.status==='failed'){statusEl.className='error';statusEl.textContent=data.error?.message||'Processing failed.';return}
statusEl.textContent='Status: '+data.status;timer=setTimeout(refresh,2000)}catch(error){statusEl.className='error';statusEl.textContent=error.message}}
refresh();window.addEventListener('beforeunload',()=>clearTimeout(timer));
</script></body></html>`;
}
