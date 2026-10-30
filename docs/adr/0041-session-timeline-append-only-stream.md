# ADR 0041 : Journal d'Événements de Session Append-Only et Ressource MCP

## Status
Accepted

## Context
L'issue #11 demande la mise en place d'une timeline chronologique retraçant les événements clés de la séance (lancers de dés, rounds de combat, transitions de salles, handouts révélés), consultable par les joueurs et exploitable par des agents d'intelligence artificielle via le protocole MCP (`get_session_timeline`) pour synthétiser des récapitulatifs narratifs de séance.
La structure de données doit garantir un ordre chronologique strict, une résilience à la concurrence et une pagination fiable par curseur.

## Decision
1. **Modèle de Données SQL Append-Only** :
   - La table `session_events` stocke les événements immuables.
   - Elle intègre explicitement `campaign_id` et `session_num` avec une colonne générée persistée `session_id VARCHAR(64) GENERATED ALWAYS AS (campaign_id || ':' || session_num) STORED`.
   - Elle applique une contrainte d'unicité stricte `UNIQUE (campaign_id, session_num, seq_id)`.
   - `seq_id` est un entier 64-bit strictement incrémental par session.
2. **Exposition Multi-Canal** :
   - En temps réel via WebSocket pour les composants de l'interface utilisateur.
   - Via l'API REST `GET /api/campaigns/{campaign_id}/sessions/{session_num}/timeline?after={seq_id}&limit={limit}`.
   - Via l'outil MCP `get_session_timeline(campaign_id, session_num)` retournant la ressource URI `campaign://{campaign_id}/sessions/{session_num}/timeline`.

## Consequences
### Positive
- Immutabilité totale garantissant un historique de session inviolable et auditabie.
- Absence de corruption lors de lectures concurrentes grâce au curseur `seq_id`.
- Alignement parfait avec les spécifications d'ingestion des agents d'IA générative.

### Negative / Trade-offs
- Nécessite une migration SQL dédiée et un index composite indexant `(campaign_id, session_num, seq_id ASC)`.