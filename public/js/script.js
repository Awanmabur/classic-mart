


// vanilla JS
var toTop = document.getElementById("goto-topJS");

  toTop.addEventListener("click", function(){
  scrollToTop(4000);
});
function scrollToTop(scrollDuration) {
    var scrollStep = -window.scrollY / (scrollDuration / 5),
        scrollInterval = setInterval(function(){
        if ( window.scrollY != 0 ) {
            window.scrollBy( 0, scrollStep );
        }
        else clearInterval(scrollInterval);
    },15);
}


// dark model

function myFunction() {
 var element = document.body;
 element.classList.toggle("dark-mode");
}



    document.addEventListener('DOMContentLoaded', function () {
      var currentYear = new Date().getFullYear();
      document.getElementById('copyright-year').innerText = currentYear;
    });




    const myslide = document.querySelectorAll('.myslide'),
    	  dot = document.querySelectorAll('.dot');
    let counter = 1;
    slidefun(counter);

    let timer = setInterval(autoSlide, 8000);
    function autoSlide() {
    	counter += 1;
    	slidefun(counter);
    }
    function plusSlides(n) {
    	counter += n;
    	slidefun(counter);
    	resetTimer();
    }
    function currentSlide(n) {
    	counter = n;
    	slidefun(counter);
    	resetTimer();
    }
    function resetTimer() {
    	clearInterval(timer);
    	timer = setInterval(autoSlide, 8000);
    }

    function slidefun(n) {

    	let i;
    	for(i = 0;i<myslide.length;i++){
    		myslide[i].style.display = "none";
    	}
    	for(i = 0;i<dot.length;i++) {
    		dot[i].className = dot[i].className.replace(' active', '');
    	}
    	if(n > myslide.length){
    	   counter = 1;
    	   }
    	if(n < 1){
    	   counter = myslide.length;
    	   }
    	myslide[counter - 1].style.display = "block";
    	dot[counter - 1].className += " active";
    }


    function showTab(tabIndex) {
      const tabHeaders = document.querySelectorAll('.tab-header');
      const tabContents = document.querySelectorAll('.tab-content');

      for (let i = 0; i < tabHeaders.length; i++) {
        tabHeaders[i].classList.remove('active');
        tabContents[i].classList.remove('active');
      }

      tabHeaders[tabIndex].classList.add('active');
      tabContents[tabIndex].classList.add('active');
    }




    const darkBtn = document.getElementById('darkBtn');
    const lightBtn = document.getElementById('lightBtn');

    darkBtn.addEventListener('click', () => {
      document.body.classList.add('dark-mode');
    });

    lightBtn.addEventListener('click', () => {
      document.body.classList.remove('dark-mode');
    });
