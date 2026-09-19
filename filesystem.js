export const fileContentMap = {
    "text.txt": "files/text.txt",
    "readpls.txt": "files/readpls.txt",
    "readme.txt": "files/readme.txt"
};

export const desktopData = [
    { 
        name: "Socials", 
        type: "folder", 
        content: [
            { name: "Mail", type: "mail" },
            { name: "YouTube", type: "link", url: "https://www.youtube.com/@SPIKETONES007", customIcon: "logos:youtube-icon" },
            { name: "Instagram", type: "link", url: "https://www.instagram.com/josh.jaison/", customIcon: "files/instagram.png" },
            { name: "Discord", type: "link", url: "https://discord.com/users/738312534502932541", customIcon: "logos:discord-icon" },
            { name: "Steam", type: "link", url: "https://steamcommunity.com/id/SPIKETONES007/", customIcon: "files/steam.png" },
            { name: "Last.fm", type: "link", url: "https://www.last.fm/user/SPIKETONES007", customIcon: "files/lastfm.png" },
        ]
    },
    { 
        name: "Links", 
        type: "folder", 
        content: [
            { 
                name: "Important Links", 
                type: "folder", 
                content: [
                    { name: "FMHY", type: "link", url: "https://fmhy.net/", customIcon: "files/fmhy.png" },
                    { name: "Monochrome", type: "link", url: "https://monochrome.tf/", customIcon: "files/Monochrome.png" },
                    { name: "Xprime", type: "link", url: "https://xprime.today/", customIcon: "files/xprime.png" }
                ]
            },
            { name: "Legacy", type: "link", url: "https://spiketones007-legacy.netlify.app/" }
        ]
    },
    { 
        name: "Music", 
        type: "folder", 
        content: []
    },
    { 
        name: "CS2", 
        type: "cs2", 
        content: []
    },
    { name: "text.txt", type: "file" },
    { name: "Snake", type: "snake" },
    { name: "Terminal", type: "terminal" },
    { name: "Paint", type: "paint" },
    { name: "Calculator", type: "calc" },
    { name: "Sticky Notes", type: "stickynotes" },
    { name: "Guestbook", type: "guestbook" }
];

export const musicLibrary = [];
