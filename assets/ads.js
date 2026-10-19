// Injects affiliate ad HTML into .ad-slot elements from ad-pool.json
// (client-side, random pick, no same-advertiser repeats on one page).
(async () => {
  // A8.net の提携はサイト単位のため、オーナーが本サイトを登録するまで広告は描画しない
  if (window.ADS_ENABLED !== true) return;
  const slots = [...document.querySelectorAll('.ad-slot[data-ad]')];
  if (!slots.length) return;
  const self = document.currentScript && document.currentScript.src;
  const poolUrl = self ? self.replace(/ads\.js(\?.*)?$/, 'ad-pool.json') : 'assets/ad-pool.json';
  let pool;
  try { pool = await (await fetch(poolUrl)).json(); } catch { return; }
  const mobile = window.matchMedia('(max-width: 780px)').matches;
  const used = new Set();
  for (const el of slots) {
    const size = (mobile && el.dataset.adMobile) ? el.dataset.adMobile : el.dataset.ad;
    let cands = (pool[size] || []).filter(e => !used.has(e.advertiser));
    if (!cands.length) cands = pool[size] || [];
    if (!cands.length) continue;
    const pick = cands[Math.floor(Math.random() * cands.length)];
    used.add(pick.advertiser);
    el.innerHTML = pick.html;
    el.classList.add('ad-filled');
  }
})();
