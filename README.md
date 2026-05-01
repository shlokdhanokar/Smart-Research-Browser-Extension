# HindSite Chrome Extension 🧠

![HindSite Branding](src/assets/icons/ext-icon-128.png)


**HindSite** is a smart Chrome Extension that automatically curates your reading list. Instead of manually bookmarking, it intelligently detects when you are deeply engaged with content and saves it for you.

## ✨ Features

- **Automated Saving**: Detects "valuable" visits based on:
  - ⏱️ **Time Spent**: Active reading time (> 60s).
  - 📜 **Scroll Depth**: reading at least 40% of the page.
  - 🏎️ **Velocity**: distinguishing between skimming/jumping and actual reading.
- **Privacy First**: All data is stored locally in your browser (`chrome.storage.local`).
- **Dashboard**: View your reading history, stats, and search through saved pages.
- **Export**: Download your entire research history as JSON.

## 🛠️ Installation

1.  Clone this repository.
2.  Open **Chrome** and navigate to `chrome://extensions/`.
3.  Toggle **Developer mode** (top right).
4.  Click **Load unpacked**.
5.  Select the `Frontend-AI-Extension` directory.

## 📂 Project Structure

```text
/
├── manifest.json
├── src/
│   ├── assets/
│   │   └── icons/          # Extension and action icons
│   ├── content/
│   │   └── index.js        # The "Brain": behavior tracking
│   ├── popup/
│   │   ├── index.html      # The "View": popup layout
│   │   └── index.js        # The "UI Logic": popup interaction
│   └── utils/              # Helper utilities
└── LICENSE
```

## 🚀 Scalability & Future Roadmap

As your research database grows, the following architectural improvements are planned:

1.  **Storage**: migrating to `indexedDB` or an external database (Firebase/Supabase) to handle thousands of saved pages without the 5MB local storage limit.
2.  **Search**: Implementing client-side full-text search (e.g., FlexSearch) or offloading search to a backend.
3.  **Sync**: validating `chrome.storage.sync` or cloud auth to share research across devices.
4.  **Intelligence**: specific extractors for academic papers (arXiv), news sites, and documentation.

## 📄 License

MIT License - see the [LICENSE](LICENSE) file for details.
