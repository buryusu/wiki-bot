const RARITY_ORDER = {
  "L": 1,
  "UR": 2,
  "SR": 3,
  "R": 4,
  "PC": 5,
  "C": 6
};

function getRarityWeight(rarity) {
  return RARITY_ORDER[rarity] || 99;
}

let allCards = [];

async function loadData() {
  const accounts = await wmphGetAccounts();
  const cards = [];
  
  for (const [email, acc] of Object.entries(accounts)) {
    if (!acc.packs || !acc.packs.length) continue;
    
    for (const pack of acc.packs) {
      if (!pack.cards || !pack.cards.length) continue;
      
      for (const card of pack.cards) {
        cards.push({
          ...card,
          account: {
            email: acc.email,
            username: acc.username,
            password: acc.password,
            createdAt: acc.createdAt,
            totalPacks: acc.totalPacks
          },
          pack: {
            openedAt: pack.openedAt,
            packId: pack.packId
          }
        });
      }
    }
  }
  
  // Sort by rarity
  cards.sort((a, b) => {
    const wA = getRarityWeight(a.rarity);
    const wB = getRarityWeight(b.rarity);
    if (wA !== wB) return wA - wB;
    // fallback to name
    return (a.name || "").localeCompare(b.name || "");
  });
  
  allCards = cards;
  renderCards(allCards);
  
  document.getElementById('statsDisplay').textContent = 
    `${allCards.length} cartes trouvées (${Object.keys(accounts).length} comptes)`;
}

function renderCards(cardsToRender) {
  const grid = document.getElementById('cardsGrid');
  const noResults = document.getElementById('noResults');
  
  grid.innerHTML = '';
  
  if (cardsToRender.length === 0) {
    noResults.classList.remove('hidden');
    return;
  }
  
  noResults.classList.add('hidden');
  
  const fragment = document.createDocumentFragment();
  
  cardsToRender.forEach((card, index) => {
    const el = document.createElement('div');
    el.className = 'card-item';
    el.dataset.rarity = card.rarity;
    
    el.innerHTML = `
      <div class="card-rarity">${card.rarity || '?'}</div>
      <div class="card-img-placeholder">🃏</div>
      <div class="card-name">${card.name || 'Inconnu'}</div>
    `;
    
    el.addEventListener('click', () => openModal(card));
    fragment.appendChild(el);
  });
  
  grid.appendChild(fragment);
}

function openModal(card) {
  const modal = document.getElementById('accountModal');
  const body = document.getElementById('modalBody');
  
  body.innerHTML = `
    <div class="detail-row">
      <div class="detail-label">Carte</div>
      <div class="detail-value">${card.name} (${card.rarity})</div>
    </div>
    <div class="detail-row">
      <div class="detail-label">Compte - Email</div>
      <div class="detail-value">${card.account.email}</div>
    </div>
    <div class="detail-row">
      <div class="detail-label">Compte - Username</div>
      <div class="detail-value">${card.account.username || '-'}</div>
    </div>
    <div class="detail-row">
      <div class="detail-label">Compte - Mot de passe</div>
      <div class="detail-value">${card.account.password}</div>
    </div>
    <div class="detail-row">
      <div class="detail-label">Date d'obtention</div>
      <div class="detail-value">${card.pack.openedAt ? new Date(card.pack.openedAt).toLocaleString() : '-'}</div>
    </div>
    <div class="detail-row">
      <div class="detail-label">Packs ouverts par le compte</div>
      <div class="detail-value">${card.account.totalPacks}</div>
    </div>
  `;
  
  modal.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('accountModal').classList.add('hidden');
}

document.getElementById('closeModal').addEventListener('click', closeModal);
document.getElementById('accountModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

document.getElementById('searchInput').addEventListener('input', (e) => {
  const term = e.target.value.toLowerCase().trim();
  if (!term) {
    renderCards(allCards);
    return;
  }
  
  const filtered = allCards.filter(c => (c.name || '').toLowerCase().includes(term));
  renderCards(filtered);
});

// Init
document.addEventListener('DOMContentLoaded', loadData);
