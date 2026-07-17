(() => {
  'use strict';
  const promoters = [
    ['Amina Style','Fashion & beauty','Trusted fashion editor sharing wearable looks and practical beauty finds.','https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=500&q=86',['Fashion','Beauty'],4.9,'84K','1.2K'],
    ['Daniel Tech','Electronics','Clear gadget comparisons, setup guides and dependable everyday technology picks.','https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=500&q=86',['Tech','Audio'],4.8,'67K','948'],
    ['Nadia Home','Home ideas','Space-saving home products, kitchen tools and simple room refresh ideas.','https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=500&q=86',['Home','Kitchen'],4.9,'52K','776'],
    ['Musa Fitness','Sports','Fitness essentials, training accessories and realistic beginner-friendly recommendations.','https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=500&q=86',['Sports','Fitness'],4.7,'46K','605'],
    ['Grace Finds','Daily deals','Value-focused marketplace finds with clear reasons each deal is worth considering.','https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=500&q=86',['Deals','Lifestyle'],4.8,'73K','1.0K'],
    ['Leo Outdoors','Travel gear','Practical travel, hiking and outdoor products selected for comfort and durability.','https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=500&q=86',['Travel','Outdoor'],4.7,'39K','512'],
    ['Ruth Beauty','Skin care','Gentle skin-care routines and transparent product explanations for everyday use.','https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=500&q=86',['Skin care','Wellness'],4.9,'58K','889'],
    ['Peter Auto','Automotive','Useful vehicle accessories, maintenance tools and organized car essentials.','https://images.unsplash.com/photo-1501196354995-cbb51c65aaea?auto=format&fit=crop&w=500&q=86',['Auto','Tools'],4.6,'31K','430'],
    ['Eva Books','Books & learning','Books, stationery and learning resources for students, families and professionals.','https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=500&q=86',['Books','Learning'],4.8,'44K','692'],
    ['Samuel Select','Marketplace picks','Balanced product roundups covering useful items across the whole marketplace.','https://images.unsplash.com/photo-1507591064344-4c6ce005b128?auto=format&fit=crop&w=500&q=86',['Popular','Mixed'],4.7,'61K','804']
  ];
  const sellers = [
    ['Classic Electronics','Verified electronics seller','Phones, audio, accessories and reliable everyday technology.','https://images.unsplash.com/photo-1560472354-b33ff0c44a43?auto=format&fit=crop&w=500&q=86',['Electronics','Warranty'],4.9,'12K','8.4K'],
    ['Urban Style House','Fashion marketplace seller','Modern clothing, shoes and accessories with clear sizing information.','https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=500&q=86',['Fashion','Fast dispatch'],4.8,'9.8K','6.7K'],
    ['HomeNest Store','Home & kitchen seller','Furniture, kitchen tools and décor selected for practical homes.','https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?auto=format&fit=crop&w=500&q=86',['Home','Kitchen'],4.8,'7.6K','5.3K'],
    ['GlowCare Market','Beauty & wellness seller','Skin care, personal care and beauty essentials from trusted brands.','https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=500&q=86',['Beauty','Wellness'],4.7,'6.1K','4.8K'],
    ['ActiveLife Shop','Sports seller','Fitness, outdoor and recreation products for active routines.','https://images.unsplash.com/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=500&q=86',['Sports','Outdoor'],4.7,'5.4K','3.9K'],
    ['BookPoint','Books & stationery seller','Learning resources, office stationery and books for every age.','https://images.unsplash.com/photo-1526243741027-444d633d7365?auto=format&fit=crop&w=500&q=86',['Books','Stationery'],4.9,'4.9K','3.5K'],
    ['AutoPro Supplies','Automotive seller','Vehicle accessories, cleaning products and maintenance essentials.','https://images.unsplash.com/photo-1486262715619-67b85e0b08d3?auto=format&fit=crop&w=500&q=86',['Automotive','Tools'],4.6,'4.1K','2.8K'],
    ['Fresh Basket','Grocery seller','Pantry staples and household essentials with organized fulfilment.','https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=500&q=86',['Grocery','Household'],4.8,'8.2K','6.1K'],
    ['PetJoy Store','Pet supplies seller','Food, care and play essentials for cats, dogs and small pets.','https://images.unsplash.com/photo-1601758228041-f3b2795255f1?auto=format&fit=crop&w=500&q=86',['Pets','Care'],4.7,'3.8K','2.4K'],
    ['ToyBox World','Toys & games seller','Creative play, family games and age-friendly children’s products.','https://images.unsplash.com/photo-1594787318286-3d835c1d207f?auto=format&fit=crop&w=500&q=86',['Toys','Games'],4.8,'5.7K','4.0K']
  ];
  const type = document.body.dataset.directoryType === 'sellers' ? 'sellers' : 'promoters';
  const source = type === 'sellers' ? sellers : promoters;
  const grid = document.querySelector('#peopleGrid');
  const query = document.querySelector('#peopleQuery');
  const sort = document.querySelector('#peopleSort');
  const count = document.querySelector('#peopleCount');
  const empty = document.querySelector('#peopleEmpty');
  const params = new URLSearchParams(location.search);
  if (params.get('q')) query.value = params.get('q');
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  function productDestination(item) {
    const key = `${item[1]} ${item[4].join(' ')}`.toLowerCase();
    if (key.includes('fashion')) return 'products.html?category=fashion';
    if (key.includes('beauty') || key.includes('skin') || key.includes('wellness')) return 'products.html?category=beauty';
    if (key.includes('electronic') || key.includes('tech') || key.includes('audio')) return 'products.html?category=electronics';
    if (key.includes('home') || key.includes('kitchen')) return 'products.html?category=home';
    if (key.includes('sport') || key.includes('fitness') || key.includes('outdoor') || key.includes('travel')) return 'products.html?category=sports';
    if (key.includes('book') || key.includes('learning') || key.includes('stationery')) return 'products.html?category=books';
    if (key.includes('auto') || key.includes('tool')) return 'products.html?category=automotive';
    if (key.includes('grocery') || key.includes('household')) return 'products.html?category=grocery';
    if (key.includes('pet')) return 'products.html?category=pets';
    if (key.includes('toy') || key.includes('game')) return 'products.html?category=toys';
    if (key.includes('deal')) return 'products.html?view=deals';
    return 'products.html?view=recommended';
  }
  function render() {
    const term = query.value.trim().toLowerCase();
    let items = source.filter(item => item.join(' ').toLowerCase().includes(term));
    if (sort.value === 'rating') items.sort((a,b)=>b[5]-a[5]);
    if (sort.value === 'name') items.sort((a,b)=>a[0].localeCompare(b[0]));
    count.textContent = `${items.length} verified ${type}`;
    empty.hidden = Boolean(items.length);
    grid.hidden = !items.length;
    grid.innerHTML = items.map((item,index)=>`<article class="person-card"><div class="person-cover"></div><div class="person-content"><img class="person-avatar" src="${esc(item[3])}" alt="${esc(item[0])}" loading="lazy" referrerpolicy="no-referrer"><span class="person-verified"><img src="assets/icons/circle-check.svg" alt="">Verified</span><h2>${esc(item[0])}</h2><p class="person-role">${esc(item[1])}</p><p class="person-bio">${esc(item[2])}</p><div class="person-metrics"><span><strong>${item[5]}</strong><small>Rating</small></span><span><strong>${esc(item[6])}</strong><small>${type==='sellers'?'Orders':'Followers'}</small></span><span><strong>${esc(item[7])}</strong><small>${type==='sellers'?'Products':'Picks'}</small></span></div><div class="person-tags">${item[4].map(tag=>`<span>${esc(tag)}</span>`).join('')}</div><div class="person-actions"><a href="${type==='sellers'?'seller-profile.html?seller='+index:'promoter-profile.html?promoter='+index}">View profile</a><a class="person-products-link" href="${productDestination(item)}">${type==='sellers'?'Products':'Picks'}</a><button type="button" data-follow="${esc(item[0])}" aria-label="Follow ${esc(item[0])}"><img src="assets/icons/heart-regular.svg" alt=""></button></div></div></article>`).join('');
  }
  document.querySelector('#peopleSearchForm')?.addEventListener('submit', e=>{e.preventDefault();render();});
  query?.addEventListener('input', render);
  sort?.addEventListener('change', render);
  document.addEventListener('click', e=>{const button=e.target.closest('[data-follow]'); if(!button)return; button.classList.toggle('active'); button.innerHTML=`<img src="assets/icons/${button.classList.contains('active')?'heart':'heart-regular'}.svg" alt="">`;});
  render();
})();
