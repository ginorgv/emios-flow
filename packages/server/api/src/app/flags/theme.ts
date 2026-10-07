import { DEFAULT_BRAND_LOGOS, PlatformThemeColors } from '@activepieces/shared'
import tinycolor from 'tinycolor2'

function generateColorVariations(defaultColor: string) {
    const defaultColorObj = tinycolor(defaultColor)

    const darkColor = defaultColorObj.clone().darken(2)
    const baseLight = tinycolor('#ffffff')
    const lightColor = tinycolor
        .mix(baseLight, defaultColorObj.toHex(), 12)
        .toHexString()
    const mediumColor = defaultColorObj.clone().lighten(26)

    return {
        default: defaultColorObj.toHexString(),
        dark: darkColor.toHexString(),
        light: lightColor,
        medium: mediumColor.toHexString(),
    }
}

function generateSelectionColor(defaultColor: string) {
    const defaultColorObj = tinycolor(defaultColor)
    const lightColor = defaultColorObj.lighten(8)
    return lightColor.toHexString()
}

export function generateTheme({
    primaryColor,
    fullLogoUrl,
    favIconUrl,
    logoIconUrl,
    websiteName,
    themeColors,
}: {
    primaryColor: string
    fullLogoUrl: string
    favIconUrl: string
    logoIconUrl: string
    websiteName: string
    themeColors?: PlatformThemeColors
}) {
    const primary = generateColorVariations(primaryColor)
    return {
        websiteName,
        colors: {
            avatar: themeColors?.avatar ?? '#515151',
            'blue-link': themeColors?.['blue-link'] ?? '#1890ff',
            danger: themeColors?.danger ?? '#f94949',
            primary: {
                default: primary.default,
                dark: themeColors?.primary?.dark ?? primary.dark,
                light: themeColors?.primary?.light ?? primary.light,
                medium: themeColors?.primary?.medium ?? primary.medium,
            },
            warn: {
                default: themeColors?.warn?.default ?? '#f78a3b',
                light: themeColors?.warn?.light ?? '#fff6e4',
                dark: themeColors?.warn?.dark ?? '#cc8805',
            },
            success: {
                default: themeColors?.success?.default ?? '#14ae5c',
                light: themeColors?.success?.light ?? '#3cad71',
            },
            selection: themeColors?.selection ?? generateSelectionColor(primaryColor),
        },
        statusColors: themeColors?.status ?? {},
        logos: {
            fullLogoUrl,
            favIconUrl,
            logoIconUrl,
        },
    }
}

// EMIOS Flow - marca propia de Energiminus (fork propio de Activepieces CE).
// Verde corporativo EMIOS: #298B21. Ver fork/GUIA-FORK-Y-BRANDING.md
export const defaultTheme = generateTheme({
    primaryColor: '#298B21',
    websiteName: 'EMIOS Flow',
    ...DEFAULT_BRAND_LOGOS,
    fullLogoUrl: '/brand/emios-logo.svg',
    favIconUrl: '/brand/emios-favicon.ico',
    logoIconUrl: '/brand/emios-icon.svg',
})
