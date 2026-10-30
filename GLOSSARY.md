# Glossaire EPURE & TRAME

Ce glossaire établit la terminologie canonique bijective du projet TRAME conformément à la norme de rédaction technique contrôlée ASD-STE100 (ADR-0031).
Chaque terme possède un sens technique unique. Les synonymes proscrits listés sous *Avoid* ne doivent jamais apparaître dans les spécifications ou le code.

---

### Companion Mode (Mode Compagnon)
- **Definition**: Interface utilisateur tactile allégée dédiée aux terminaux mobiles et tablettes dont la largeur d'affichage est strictement inférieure à 768 pixels, désactivant le moteur de rendu WebGL pour préserver l'autonomie et les performances.
- **Avoid**: Mobile view, Lite app, Responsive fallback, Phone skin.

### CRDT (Conflict-free Replicated Data Type)
- **Definition**: Structure de données répliquée sans conflit (Yjs côté client, `yrs` côté serveur) garantissant la convergence mathématique d'un document texte partagé entre plusieurs pairs sans verrou distribué.
- **Avoid**: Real-time sync engine, Operational Transform, Delta merge.

### Directive Block (Bloc Directive)
- **Definition**: Bloc de syntaxe Markdown délimité par des triples deux-points `:::nom{cle="valeur"}` interprété par le compilateur AST pour encapsuler des éléments interactifs ou filtrés (`:::handout`, `:::dm`).
- **Avoid**: Shortcode, Custom tag, Special markup, Admonition.

### Handout (Document à Révéler)
- **Definition**: Artefact textuel ou visuel secret rédigé par le Maître de Jeu dans une note, possédant un identifiant unique, conservé secret jusqu'à son action explicite de révélation à l'ensemble des joueurs.
- **Avoid**: Secret clue, Player reveal, Clue card, Public paper.

### Handout Reveal Modal (Modal de Révélation)
- **Definition**: Composant d'interface s'affichant en superposition plein écran sur tous les clients connectés lorsqu'un Maître de Jeu diffuse l'événement de révélation d'un Handout.
- **Avoid**: Popup, Dialog window, Handout lightbox, Alert box.

### MobileCompanionLayout
- **Definition**: Coquille d'interface racine montée lorsque la largeur d'écran est strictement inférieure à 768 pixels, intégrant une barre de navigation inférieure à quatre onglets tactiles (`Sheet`, `Dice`, `Inventory`, `Journal`).
- **Avoid**: MobileShell, SmallScreenLayout, TabContainer.

### Party Journal (Journal de Groupe)
- **Definition**: Document textuel ou registre centralisé de notes partagé entre tous les participants d'une campagne, archivant de manière permanente les événements et Handouts révélés.
- **Avoid**: Group log, Campaign diary, Shared notebook, Quest log.

### Public Snapshot (Instantané Public)
- **Definition**: Représentation textuelle Markdown assainie et purgée de tout bloc secret (`:::dm` et `:::handout{revealed="false"}`), diffusée par `trame-server` aux clients non-MJ via WebSocket.
- **Avoid**: Sanitized content, Public markdown, Filtered copy.

### Session Timeline (Chronologie de Session)
- **Definition**: Flux d'événements append-only ordonné de manière strictement croissante par `seq_id`, indexé par `campaign_id` et `session_num`, retraçant l'ensemble des actions vérifiables d'une séance de jeu.
- **Avoid**: Game history, Event stream, Activity feed, Audit trail.

### TableCanvas
- **Definition**: Composant applicatif lourd montant le viewport de table virtuelle, initialisant l'instance PixiJS, les nuanceurs d'éclairage dynamique et les Framebuffer Objects (FBO) WebGL.
- **Avoid**: GameMap, BoardView, PixiContainer, CanvasRenderer.

### Wiki Autocomplete (Complétion Wiki)
- **Definition**: Mécanisme de suggestion textuelle déclenché par la saisie de doubles crochets `[[` permettant d'insérer des hyperliens internes vers des acteurs, lieux ou objets du compendium.
- **Avoid**: Wiki link popup, Entity suggester, Smart mention, Quick search.
