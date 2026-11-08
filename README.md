# Vijuga

Igra zmija u areni za do 6 igrača (ljudi i botovi), u pregledniku i na mobitelu.

- `src/game.html`: cijela igra (HTML, CSS i JS u jednoj datoteci).
- `build.sh`: omota igru u punu stranicu `site/index.html`.
- `site/`: ono što se objavljuje (Render static site, publish path `site`).

## Online dio

- Predvorje, chat, pozivi i meč: Supabase Realtime (javni kanal `vijuga-lobby`). Zasebna soba: dodaj `?soba=ime` na adresu (npr. za testiranje ili privatnu igru).
- Zajednički profili: tablica `vijuga_accounts` (SQL u `supabase.sql`). Bez nje se profili pamte u pregledniku.

## Lokalno

Otvori `site/index.html` u pregledniku.
