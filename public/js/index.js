
    async function searchItems(query) {
               const response = await fetch(`/search?query=${query}`);
               const data = await response.text();
               displayResults(data);
           }

           function displayResults(html) {
               const resultsContainer = document.getElementById('results');
               resultsContainer.innerHTML = html;
           }

           document.addEventListener('DOMContentLoaded', () => {
               const desktopSearchInput = document.getElementById('desktop-search-input');
               const mobileSearchInput = document.getElementById('mobile-search-input');

               const handleSearchInput = (e) => {
                   const query = e.target.value;
                   if (query) {
                       searchItems(query);
                   } else {
                       document.getElementById('results').innerHTML = '';
                   }
               };

               desktopSearchInput.addEventListener('input', handleSearchInput);
               mobileSearchInput.addEventListener('input', handleSearchInput);
           });



    const myslideit = document.querySelectorAll('.myslideit'),
        dotit = document.querySelectorAll('.dotit');
    let counterit = 1;
    slidefun1(counterit);

    let amok = setInterval(autoSlide, 7000);
    function autoSlide() {
      counterit += 1;
      slidefun1(counterit);
    }
    function plusSlidesit(n) {
      counterit += n;
      slidefun1(counterit);
      resetTimer();
    }
    function currentSlideit(n) {
      counterit = n;
      slidefun1(counterit);
      resetTimer();
    }
    function resetTimer() {
      clearInterval(amok);
      amok = setInterval(autoSlide, 7000);
    }

    function slidefun1(n) {

      let i;
      for(i = 0;i<myslideit.length;i++){
        myslideit[i].style.display = "none";
      }
      for(i = 0;i<dotit.length;i++) {
        dotit[i].className = dotit[i].className.replace(' active', '');
      }
      if(n > myslideit.length){
         counterit = 1;
         }
      if(n < 1){
         counterit = myslideit.length;
         }
      myslideit[counterit - 1].style.display = "block";
      dotit[counterit - 1].className += " active";
    }


    const link = encodeURI(window.location.href);
    const msg = encodeURIComponent('Please check this awesome product');
    const title = encodeURIComponent('.item_title');

    const fb = document.querySelector('.facebook');
    fb.href = `https://www.facebook.com/share.php?u=${link}`;

    const whatsapp = document.querySelector('.whatsapp');
    whatsapp.href = `https://api.whatsapp.com/send?text=${msg}: ${title}: ${link}`;

    const instagram = document.querySelector('.instagram');
    instagram.href = `https://www.instagram.com?=${msg}: ${link}`;

    const telegram = document.querySelector('.telegram');
    telegram.href = `https://telegram.me/share/url?url=${link}&text=${msg}`;
