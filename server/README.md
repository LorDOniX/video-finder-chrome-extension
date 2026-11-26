# Download server

Lokální server pro stahování HLS (m3u8) videí z doplňku. Běží ve WSL, stahuje přes `ffmpeg`
do Windows složky `Downloads` a doplňku (DevTools panel „Videos“) hlásí průběh.

## Spuštění

```sh
sudo apt install ffmpeg   # pokud chybí
npm run server
```

Složka pro stažení se zjistí automaticky (`%USERPROFILE%\Downloads` → `/mnt/c/Users/<uživatel>/Downloads`).

## Konfigurace (env)

| Proměnná         | Výchozí            | Popis                                                        |
|------------------|--------------------|--------------------------------------------------------------|
| `PORT`           | `9787`             | Port (doplněk volá `http://localhost:9787`, viz `SERVER_URL` v `panel.js`) |
| `HOST`           | `127.0.0.1`        | Adresa, na které server poslouchá                            |
| `DOWNLOAD_DIR`   | Windows Downloads  | Cílová složka                                                |
| `MAX_CONCURRENT` | `3`                | Max. počet souběžných stahování, další čekají ve frontě      |
| `EXTENSION_IDS`  | –                  | ID doplňků (oddělená čárkou), které smí server volat; jinak jakýkoliv `chrome-extension://` |
| `FFMPEG`         | `ffmpeg`           | Cesta k ffmpeg                                               |

## API

- `GET /health` – stav serveru
- `GET /downloads` – seznam stahování (nejnovější první)
- `POST /downloads` `{ url, title, headers }` – spustí stahování; `headers` (referer, cookie, user-agent, …) se předají ffmpeg
- `DELETE /downloads/:id` – zruší běžící stahování, u dokončeného jen odebere záznam ze seznamu (soubor zůstává)

Požadavky s `Origin` jiné stránky než doplňku server odmítá, aby stahování nemohl spustit libovolný web.
