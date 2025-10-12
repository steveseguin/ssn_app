'use strict';

const INVISIBLE_CHAR_PATTERN = /[\u200B-\u200D\u200E\u200F\u202A-\u202E\u2060\uFE0E-\uFE0F\uFEFF]/g;

function cleanVisibleString(value) {
    if (value === undefined || value === null) return null;
    const str = String(value);
    const cleaned = str.replace(INVISIBLE_CHAR_PATTERN, '').trim();
    return cleaned || null;
}

function firstNonEmptyVisibleString(values) {
    if (!Array.isArray(values)) return null;
    for (const value of values) {
        const cleaned = cleanVisibleString(value);
        if (cleaned) return cleaned;
    }
    return null;
}

function normalizeTikTokBadgeLevel(rawLevel) {
    if (rawLevel === undefined || rawLevel === null) return null;

    const numeric = Number(rawLevel);
    if (Number.isFinite(numeric) && numeric > 0) {
        return numeric;
    }

    if (typeof rawLevel === 'string') {
        const trimmed = rawLevel.trim();
        if (!trimmed) return null;

        const parsed = Number(trimmed);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }

        const digitMatch = trimmed.match(/\d+/);
        if (digitMatch) {
            const fallback = Number(digitMatch[0]);
            if (Number.isFinite(fallback) && fallback > 0) {
                return fallback;
            }
        }
    }

    return null;
}

function normalizeTikTokImageUrl(value, seen) {
    if (value === undefined || value === null) return null;

    if (!seen) {
        seen = new Set();
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('//')) {
            return `https:${trimmed}`;
        }
        return trimmed;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return null;
    }

    if (typeof value === 'object') {
        if (value === null) return null;
        if (seen.has(value)) return null;
        seen.add(value);

        if (typeof value.href === 'string') {
            return normalizeTikTokImageUrl(value.href, seen);
        }

        const directKeys = ['url', 'uri', 'src', 'mUri'];
        for (const key of directKeys) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                const resolved = normalizeTikTokImageUrl(value[key], seen);
                if (resolved) return resolved;
            }
        }

        const listKeys = ['urlList', 'urls', 'url_list', 'uriList', 'uri_list', 'iconList', 'icon_list', 'imageList', 'image_list'];
        for (const key of listKeys) {
            if (Array.isArray(value[key])) {
                const resolved = normalizeTikTokImageUrl(value[key], seen);
                if (resolved) return resolved;
            }
        }

        const nestedKeys = ['icon', 'icons', 'image', 'images', 'badgeIcon', 'badgeImage', 'badge_icon', 'badge_image', 'combine', 'background', 'backgroundDarkMode', 'backgroundImage', 'resource', 'resources', 'asset', 'assets', 'picture', 'pictures', 'pic', 'logo'];
        for (const key of nestedKeys) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                const resolved = normalizeTikTokImageUrl(value[key], seen);
                if (resolved) return resolved;
            }
        }

        const values = Object.values(value);
        for (const item of values) {
            const resolved = normalizeTikTokImageUrl(item, seen);
            if (resolved) return resolved;
        }
    }

    return null;
}

function collectBadgeImageUrls(input) {
    const urls = [];
    const seenUrls = new Set();
    const seenObjects = new Set();
    const queue = [input];

    const pushUrl = (candidate) => {
        const normalised = normalizeTikTokImageUrl(candidate);
        if (!normalised) return;
        if (!/^https?:\/\//i.test(normalised)) return;
        if (seenUrls.has(normalised)) return;
        seenUrls.add(normalised);
        urls.push(normalised);
    };

    while (queue.length) {
        const current = queue.shift();
        if (current === undefined || current === null) continue;

        if (typeof current === 'string') {
            pushUrl(current);
            continue;
        }

        if (Array.isArray(current)) {
            for (const item of current) {
                queue.push(item);
            }
            continue;
        }

        if (typeof current !== 'object') {
            continue;
        }

        if (seenObjects.has(current)) {
            continue;
        }
        seenObjects.add(current);

        const directKeys = ['url', 'uri', 'src', 'mUri'];
        for (const key of directKeys) {
            if (Object.prototype.hasOwnProperty.call(current, key)) {
                queue.push(current[key]);
            }
        }

        const listKeys = ['urlList', 'urls', 'url_list', 'uriList', 'uri_list', 'iconList', 'icon_list', 'iconUrls', 'icon_urls', 'imageList', 'image_list'];
        for (const key of listKeys) {
            if (Object.prototype.hasOwnProperty.call(current, key)) {
                queue.push(current[key]);
            }
        }

        const nestedKeys = ['icon', 'icons', 'image', 'images', 'badgeIcon', 'badgeImage', 'badge_icon', 'badge_image', 'combine', 'background', 'backgroundDarkMode', 'backgroundImage', 'resource', 'resources', 'asset', 'assets', 'picture', 'pictures', 'pic', 'logo'];
        for (const key of nestedKeys) {
            if (Object.prototype.hasOwnProperty.call(current, key)) {
                queue.push(current[key]);
            }
        }

        for (const value of Object.values(current)) {
            if (typeof value === 'string' || typeof value === 'object') {
                queue.push(value);
            }
        }
    }

    return urls;
}

function parseBadgeLevelFromUrl(url) {
    if (typeof url !== 'string') return null;
    const match = url.match(/(?:^|[\/_-])lv(\d+)(?=[^\d]|$)/i);
    if (!match) return null;

    const level = Number(match[1]);
    if (!Number.isFinite(level) || level <= 0) {
        return null;
    }

    return level;
}

function extractBadgeLevel(badge) {
    const levelCandidates = [
        badge.level,
        badge.badgeLevel,
        badge.badge_level,
        badge.displayLevel,
        badge.display_level,
        badge.gradeLevel,
        badge.grade_level,
        badge.currentLevel,
        badge.current_level,
        badge.vipLevel,
        badge.vip_level,
        badge.fanLevel,
        badge.fan_level,
        badge.rankLevel,
        badge.rank_level,
        badge.logExtra?.level,
        badge.log_extra?.level,
        badge.privilegeLogExtra?.level,
        badge?.combine?.str,
        badge?.combine?.level,
        badge?.combine?.badgeLevel,
        badge?.combine?.badge_level,
        badge?.combine?.icon?.level,
        badge?.combine?.icon?.str,
        badge?.combine?.icon?.text
    ];

    for (const candidate of levelCandidates) {
        const normalized = normalizeTikTokBadgeLevel(candidate);
        if (normalized !== null) {
            return normalized;
        }
    }

    const urlSources = [
        badge.url,
        badge.iconUrl,
        badge.icon_url,
        badge.imageUrl,
        badge.image_url,
        badge.combine?.icon?.url,
        badge.combine?.icon?.urlList,
        badge.combine?.icon?.url_list,
        badge.combine?.background?.image?.url,
        badge.combine?.backgroundDarkMode?.image?.url,
        badge.icon?.url,
        badge.icon?.urlList,
        badge.image?.url,
        badge.image?.urlList,
        badge.urlList,
        badge.urls,
        badge.url_list,
        badge.iconList,
        badge.icon_list,
        badge.imageList,
        badge.image_list
    ];

    for (const source of urlSources) {
        const level = parseBadgeLevelFromUrl(normalizeTikTokImageUrl(source));
        if (level !== null) {
            return level;
        }
        if (Array.isArray(source)) {
            for (const item of source) {
                const parsed = parseBadgeLevelFromUrl(normalizeTikTokImageUrl(item));
                if (parsed !== null) {
                    return parsed;
                }
            }
        }
    }

    return null;
}

function chooseBadgeUrl(urls, sceneType, level) {
    if (!Array.isArray(urls) || urls.length === 0) {
        return null;
    }

    const normalizedTargetLevel = normalizeTikTokBadgeLevel(level);
    const lowerCaseUrls = urls.map(url => url.toLowerCase());

    if (normalizedTargetLevel !== null) {
        const levelFragments = [];
        if (sceneType === 8) {
            const bounded = Math.max(1, Math.min(50, Math.floor(normalizedTargetLevel / 5) * 5));
            levelFragments.push(`lv${bounded}`);
        } else if (sceneType === 10) {
            const bounded = Math.max(1, Math.floor(normalizedTargetLevel / 10) * 10);
            levelFragments.push(`lv${bounded}`);
            if (normalizedTargetLevel < 2) {
                levelFragments.unshift('lv1');
            }
        } else {
            levelFragments.push(`lv${Math.floor(normalizedTargetLevel)}`);
        }

        for (const fragment of levelFragments) {
            const index = lowerCaseUrls.findIndex(url => url.includes(fragment));
            if (index !== -1) {
                return urls[index];
            }
        }
    }

    let bestMatch = null;
    let bestDiff = Infinity;
    let bestLevel = -Infinity;

    for (let index = 0; index < urls.length; index += 1) {
        const url = urls[index];
        const parsedLevel = parseBadgeLevelFromUrl(url);
        if (parsedLevel === null) {
            continue;
        }

        if (normalizedTargetLevel !== null) {
            const diff = Math.abs(parsedLevel - normalizedTargetLevel);
            if (diff < bestDiff || (diff === bestDiff && parsedLevel > bestLevel)) {
                bestDiff = diff;
                bestLevel = parsedLevel;
                bestMatch = url;
            }
        } else if (parsedLevel > bestLevel) {
            bestLevel = parsedLevel;
            bestMatch = url;
        }
    }

    if (bestMatch) {
        return bestMatch;
    }

    return urls[0];
}

function collectTikTokBadges(data = {}) {
    const result = [];
    const seen = new Set();

    const addBadge = (badge) => {
        if (!badge) return;
        if (typeof badge === 'string') {
            const normalised = normalizeTikTokImageUrl(badge);
            const key = normalised || cleanVisibleString(badge);
            if (!key || seen.has(key)) return;
            seen.add(key);
            result.push(normalised || key);
            return;
        }

        if (typeof badge !== 'object') return;
        const keyParts = [
            badge.badgeId,
            badge.id,
            badge.iconUrl,
            badge.imageUrl,
            badge.icon,
            badge.name,
            badge.badgeSceneType !== undefined ? `scene:${badge.badgeSceneType}` : null,
            badge.level !== undefined ? `level:${badge.level}` : null
        ].filter(Boolean);
        const key = keyParts.length ? keyParts.join('|') : JSON.stringify(badge);
        if (seen.has(key)) return;
        seen.add(key);
        result.push(badge);
    };

    const candidateArrays = [
        data.userBadges,
        data.badges,
        data.badgeList,
        data.badgeImageList,
        data.badgePreviewList,
        data?.user?.badges,
        data?.user?.userBadges,
        data?.user?.badgeImageList,
        data?.user?.badgeList,
        data?.user?.badgePreviewList,
        data?.user?.extraInfo?.badges,
        data?.user?.badgeIcons,
        data?.user?.badgeIconList,
        data?.user?.badge_icon_list,
        data?.user?.profile?.badges,
        data?.author?.badges,
        data?.author?.userBadges,
        data?.author?.badgeList,
        data?.author?.badgeImageList,
        data?.author?.badgeIcons,
        data?.author?.extraInfo?.badges,
        data?.extraInfo?.badges
    ];

    candidateArrays.forEach(arr => {
        if (Array.isArray(arr)) {
            arr.forEach(addBadge);
        }
    });

    return result;
}

function getBadgeImageUrl(badge) {
    if (!badge) {
        return null;
    }

    if (typeof badge === 'string') {
        const trimmed = badge.trim();
        return trimmed || null;
    }

    if (typeof badge !== 'object') {
        return null;
    }

    const sceneType = badge.badgeSceneType ?? badge.badgeScene ?? badge.sceneType ?? badge.scene;
    const derivedLevel = extractBadgeLevel(badge);
    const urls = collectBadgeImageUrls(badge);

    if (urls.length) {
        const selected = chooseBadgeUrl(urls, sceneType, derivedLevel);
        if (selected) {
            return selected;
        }
    }

    let fallbackLevel = derivedLevel !== null ? derivedLevel : normalizeTikTokBadgeLevel(badge.level);
    if (fallbackLevel === null) {
        fallbackLevel = Number(badge.level);
    }
    if (!Number.isFinite(fallbackLevel) || fallbackLevel <= 0) {
        fallbackLevel = 1;
    }

    if (sceneType === 8) {
        let level = Math.min(50, fallbackLevel);
        let version = 'v1';
        if (level >= 35 && level < 40) {
            version = 'v3';
        } else if ((level >= 15 && level < 20) || (level >= 40 && level < 45)) {
            version = 'v2';
        }
        const tier = (Math.floor(level / 5) * 5) || 1;
        return `https://p16-webcast.tiktokcdn.com/webcast-va/grade_badge_icon_lite_lv${tier}_${version}.png~tplv-obj.image`;
    }

    if (sceneType === 10) {
        const tier = (Math.floor(fallbackLevel / 10) * 10) || 1;
        const grey = fallbackLevel < 2 ? '_grey' : '';
        return `https://p16-webcast.tiktokcdn.com/webcast-va/fans_badge_icon_lv${tier}${grey}_v0.png~tplv-obj.image`;
    }

    if (sceneType === 2) {
        return 'https://p16-webcast.tiktokcdn.com/webcast-va/new_gifter_badge_v3.png~tplv-obj.image';
    }

    if (sceneType === 1) {
        return 'https://p16-webcast.tiktokcdn.com/webcast-va/moderater_badge_icon.png~tplv-obj.image';
    }

    return null;
}

module.exports = {
    cleanVisibleString,
    firstNonEmptyVisibleString,
    normalizeTikTokBadgeLevel,
    normalizeTikTokImageUrl,
    collectTikTokBadges,
    getBadgeImageUrl
};
