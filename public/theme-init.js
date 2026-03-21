// Restaure le thème sombre avant le premier rendu (évite le flash de thème clair)
if (localStorage.getItem('seedash-theme') === 'dark') {
  document.documentElement.setAttribute('data-theme', 'dark');
  document.getElementById('meta-theme-color')?.setAttribute('content', '#0f0f11');
}
// Pré-applique la classe ready si l'utilisateur était connecté → évite la page blanche
if (localStorage.getItem('seedash-authed')) {
  document.documentElement.classList.add('ready');
}
