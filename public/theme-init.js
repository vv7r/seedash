// Restaure le thème sombre avant le premier rendu (évite le flash de thème clair)
if (localStorage.getItem('seedash-theme') === 'dark') {
  document.documentElement.setAttribute('data-theme', 'dark');
}
