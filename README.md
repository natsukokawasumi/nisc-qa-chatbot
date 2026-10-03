# NiSC Q&A Chatbot

A lightweight Q&A chatbot for NiSC, built with Cloudflare Workers and Google Gemini API, with interaction logs recorded to Google Sheets via Google Apps Script.

## Features

- Answers common questions about NiSC
- Provides information about studying and student life in Singapore
- Uses Google Gemini API for natural-language responses
- Retrieves structured information from Google Sheets
- Records interaction logs to Google Sheets via Google Apps Script
- Runs serverlessly on Cloudflare Workers

## Tech Stack

- JavaScript
- Cloudflare Workers
- Google Gemini API
- Google Apps Script
- Google Sheets

## How It Works

1. The user submits a question through the chatbot interface.
2. The Cloudflare Worker processes the request.
3. Relevant information is retrieved from the knowledge base.
4. Google Gemini generates the response.
5. Interaction data is logged to Google Sheets via Google Apps Script.

## Live Demo

[Try the NiSC Q&A Chatbot](https://nisc-chatbot.nus-nisc.workers.dev/)

## Security

API keys and other credentials are stored using Cloudflare Workers Secrets and are not included in this repository.
