document.getElementById('share-button').addEventListener('click', async () => {
    if (navigator.share) {
        try {
            await navigator.share({
                title: document.title,
                text: 'Check out this page!',
                url: encodeURI(window.location.href),
            });
            console.log('Page shared successfully');
        } catch (error) {
            console.error('Error sharing the page:', error);
        }
    } else {
        alert('Web Share API not supported in this browser.');
    }
});
