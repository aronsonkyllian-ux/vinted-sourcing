# Sourcing Vinted

Site installable (PWA) pour le système d'achat-revente Vinted.
Données : `data/offers.json` et `data/brands.json`, régénérées depuis le dossier parent.

## En local

Depuis la racine du projet :

```
python3 publish_site.py --serve
```

Puis ouvre http://127.0.0.1:8788/

## Publier

Même méthode que MEME VORTEX et Nexus : GitHub Pages, dépôt public, racine de la branche `main`.
Le script `../publish_site.py` copie les données, met à jour le cache, et pousse si un jeton et un dépôt sont configurés.
