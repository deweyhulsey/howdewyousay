const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json());
app.use(express.static("public"));

/**
 * Extract pronunciations from dictionary.com
 * Filters out "lateral" and other unrelated pronunciations
 * by selecting only the dominant folder prefix (e.g., L02 for "like").
 */
async function getAudioUrls(word) {
    const url = `https://www.dictionary.com/browse/${word}`;
    const { data } = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0" }
    });

    const $ = cheerio.load(data);

    // Step 1: collect all pronunciations
    const all = [];
    $("[data-audiosrc][data-audioorigin]").each((i, el) => {
        const origin = $(el).attr("data-audioorigin");
        const src = $(el).attr("data-audiosrc");
        if (origin && src) {
            all.push({ origin, src });
        }
    });

    if (all.length === 0) return [];

    // Step 2: determine dominant prefix (e.g. "L02")
    const counts = {};
    for (const a of all) {
        const prefix = a.src.split("/")[0]; // e.g. "L02"
        counts[prefix] = (counts[prefix] || 0) + 1;
    }

    const dominantPrefix = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])[0][0];

    // Step 3: keep only pronunciations with that prefix
    const urls = all
        .filter(a => a.src.startsWith(dominantPrefix))
        .map(a => `${a.origin}/${a.src}`);

    return urls;
}

/**
 * Download a file to disk
 */
async function downloadFile(url, path) {
    const response = await axios({
        url,
        responseType: "stream",
        headers: {
            "User-Agent": "Mozilla/5.0"
        }
    });

    return new Promise(resolve => {
        response.data.pipe(fs.createWriteStream(path)).on("close", resolve);
    });
}

/**
 * Main speak endpoint
 */
app.post("/speak", async (req, res) => {
    const words = req.body.text.split(/\s+/);
    const speakAll = req.body.all === true;   // toggle from frontend
    console.log("Words:", words, "Speak all:", speakAll);

    const audioFiles = [];

    for (let i = 0; i < words.length; i++) {
        const w = words[i].toLowerCase();
        const audioUrls = await getAudioUrls(w);

        console.log(`Word: ${w}, Audio URLs:`, audioUrls);

        // Apply toggle: all pronunciations or only the first
        const pronunciations = speakAll
            ? audioUrls
            : audioUrls.slice(0, 1);

        for (let j = 0; j < pronunciations.length; j++) {
            const filePath = `tmp_${i}_${j}.mp3`;
            await downloadFile(pronunciations[j], filePath);
            audioFiles.push(filePath);

            // Insert "or" between pronunciations
            if (pronunciations.length > 1 && j < pronunciations.length - 1) {
                const orUrls = await getAudioUrls("or");
                if (orUrls.length > 0) {
                    const orPath = `tmp_${i}_or_${j}.mp3`;
                    await downloadFile(orUrls[0], orPath);
                    audioFiles.push(orPath);
                }
            }
        }
    }

    if (audioFiles.length === 0) {
        console.log("No audio files found.");
        return res.status(400).send("No audio found for any words.");
    }

    const output = "output.mp3";
    const command = ffmpeg();

    audioFiles.forEach(f => command.input(f));

    command
        .on("end", () => {
            audioFiles.forEach(f => fs.unlinkSync(f));
            res.sendFile(output, { root: __dirname });
        })
        .on("error", err => {
            console.error("FFmpeg error:", err);
            res.status(500).send("Audio merge failed.");
        })
        .mergeToFile(output);
});

/**
 * Debug endpoint
 */
app.get("/debug/:word", async (req, res) => {
    const word = req.params.word;
    const url = `https://www.dictionary.com/browse/${word}`;

    try {
        const { data } = await axios.get(url, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        res.type("text/plain").send(data);
    } catch (err) {
        res.status(500).send("Failed to fetch page");
    }
});

app.listen(3000, () =>
    console.log("Server running on http://localhost:3000")
);
