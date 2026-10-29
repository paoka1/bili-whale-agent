import '@mantine/core/styles.css'
import './app.css'
import { createTheme, MantineProvider, rem } from '@mantine/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'

// Mantine 默认 xs=12px、sm=14px，中文读着偏小：整体上调，正文、标签、说明文字、小按钮一起变大
const theme = createTheme({
  fontSizes: { xs: rem(14), sm: rem(15), md: rem(16), lg: rem(18), xl: rem(20) },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <App />
    </MantineProvider>
  </StrictMode>,
)
