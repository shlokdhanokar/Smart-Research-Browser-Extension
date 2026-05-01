# Smart Research Browser Extension 🧠

![Smart Research Browser Extension](src/assets/icons/ext-icon-128.png)

**Smart Research Browser Extension** is an intelligent, AI-powered tool that automatically curates your reading list and research history. Instead of manually bookmarking tabs, it intelligently detects when you are deeply engaged with content and saves it for you in a vector database for instant semantic search and retrieval.

## ✨ Features

- **🧠 Automated Capture**: The extension intelligently detects "valuable" browsing sessions using:
  - ⏱️ **Time Spent**: Active reading time (> 60s).
  - 📜 **Scroll Depth**: Reading at least 40% of the page.
  - 🏎️ **Velocity Tracking**: Distinguishing between quick skimming and actual reading.
- **🔍 Semantic Search & Reranking**: Powered by a Python FastAPI backend, Cohere embeddings, and PostgreSQL `pgvector`, allowing you to find exactly what you read, even if you don't remember the exact keywords.
- **🖼️ Visual Context**: Captures page thumbnails automatically, so you can visually identify your past research.
- **🔒 Privacy First**: Your data is yours. Run the backend locally with Docker and keep your browsing data completely private.
- **📊 Interactive Dashboard**: View your research history, analyze reading stats, and instantly pull up previously saved content.

## 🏗️ Architecture

The project is split into two main components:

1. **Frontend Extension**: A Chrome extension built with vanilla JavaScript and HTML/CSS that monitors user engagement and captures page content using Mozilla's Readability.js.
2. **Backend API**: A robust FastAPI application that processes page content, generates semantic embeddings using Cohere, and stores them in a PostgreSQL database equipped with `pgvector` for lightning-fast similarity search.

## 🛠️ Installation & Setup

### 1. Backend Setup

The backend relies on PostgreSQL with the `pgvector` extension. The easiest way to get started is using Docker.

```bash
cd hindsite-backend
```

Create a `.env` file in the `hindsite-backend` directory and add your Cohere API key:
```env
COHERE_API_KEY=your_cohere_api_key_here
```

Start the backend services:
```bash
docker-compose up -d
```
The FastAPI server will be available at `http://localhost:8000`.

### 2. Extension Installation

1. Open **Google Chrome** (or any Chromium-based browser) and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** in the top right corner.
3. Click **Load unpacked**.
4. Select the root directory of this repository (the folder containing `manifest.json`).

## 📂 Repository Structure

```text
/
├── manifest.json
├── src/                    # Chrome Extension Frontend
│   ├── assets/             # Extension icons
│   ├── background/         # Background service worker
│   ├── content/            # Content scripts (Readability, engagement tracking)
│   ├── popup/              # Extension popup UI
│   └── quicksearch/        # Search interface
└── hindsite-backend/       # FastAPI Backend API
    ├── app/                # Application logic (routers, models, schemas)
    ├── docker/             # Docker configuration and init scripts
    ├── docker-compose.yml  # Container orchestration
    └── requirements.txt    # Python dependencies
```

## 🚀 Future Roadmap

- **Database Alternatives**: Support for lightweight local embedding generation and `indexedDB` storage for users who prefer a completely serverless local experience.
- **Multi-Device Sync**: Optional cloud sync configuration for sharing research across different devices securely.
- **Domain-Specific Extractors**: Enhanced extraction rules for platforms like arXiv, GitHub, and major news outlets.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
