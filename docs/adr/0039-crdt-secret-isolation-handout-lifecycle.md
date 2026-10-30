# ADR 0039 : Isolation des Secrets CRDT et Cycle de Vie des Handouts

## Status
Accepted

## Context
L'issue #11 exige une interface de prise de notes collaborative Markdown supportant l'édition multi-curseurs en temps réel (via Yjs côté client et `yrs` côté serveur Rust), l'autocomplétion des hyperliens `[[Entity]]`, et la manipulation de blocs de contenu spécifiques au Maître de Jeu (`:::dm` et `:::handout`).
Un problème critique de sécurité et d'intégrité de données se pose : dans une architecture CRDT naive, les deltas binaires échangés sur le réseau contiennent l'intégralité des caractères saisis. Si des clients joueurs synchronisent directement le document Yjs contenant des blocs secrets ou des indices non révélés (`:::handout{id="..." revealed="false"}`), le texte secret transite sur le réseau et réside en mémoire sur les postes clients. Inversement, une sanitization textuelle directe appliquée aux deltas binaires Yjs brise les vecteurs d'état CRDT (`StateVector`) et provoque une désynchronisation irréversible entre le Maître de Jeu et les joueurs.

## Decision
1. **Découplage des Canaux de Synchronisation** :
   - Les clients avec le rôle `GameMaster` se connectent au canal WebSocket faisant autorité Yjs/`yrs` : `notes:{note_id}:dm`.
   - Les clients avec le rôle `Player` ou `Spectator` NE se connectent JAMAIS au canal brut Yjs/`yrs`. Ils s'abonnent exclusivement au canal WebSocket `notes:{note_id}:public`.
2. **Génération d'Instantané Public Filtré (Zero-Trust Leakage)** :
   - À chaque mise à jour du document Yjs autoritaire, `trame-server` compile l'arbre de syntaxe abstraite (AST) du document Markdown.
   - Le serveur supprime tous les blocs `:::dm` ainsi que tous les blocs `:::handout` ayant l'attribut `revealed="false"`.
   - Le serveur diffuse l'instantané Markdown assaini résultant (`Public Snapshot`) sur le canal `notes:{note_id}:public`.
3. **Grammaire Canonique des Directives Handout** :
   - Syntaxe normalisée stricte clé-valeur : `:::handout{id="<uuid>" title="<string>" revealed="<boolean>"}`.
4. **Cycle de Révélation d'un Handout** :
   - Lorsqu'un Maître de Jeu active le bouton `[ Reveal to Party ]`, le client émet la commande `notes.reveal_handout(handout_id)`.
   - `trame-server` bascule l'attribut du bloc en `revealed="true"` dans le document Yjs faisant autorité, persiste le handout dans la table `party_journal_entries`, insère un événement `HandoutRevealed` dans `session_events`, et diffuse un événement WebSocket `handout.revealed` provoquant l'ouverture immédiate de la `HandoutRevealModal` sur tous les terminaux joueurs connectés.

## Consequences
### Positive
- Élimination totale de la fuite d'informations secrètes vers les clients non autorisés (garantie réseau et mémoire).
- Préservation de l'intégrité des vecteurs d'état CRDT Yjs, sans manipulation hasardeuse des deltas binaires.
- Révélation synchrone et persistante dans le Journal de Groupe.

### Negative / Trade-offs
- Les joueurs ne disposent pas d'un curseur d'édition collaboratif sur les notes privées du MJ (comportement attendu du JdR).
- Recompilation AST côté serveur à chaque flush de transaction CRDT sur les documents partagés.