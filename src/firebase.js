import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getDatabase } from 'firebase/database'

const firebaseConfig = {
  apiKey: 'AIzaSyAhkpwJLeTeyq5_pmUSGGYfb6bvgXnFOic',
  authDomain: 'feihuasplatoon.firebaseapp.com',
  databaseURL:
    'https://feihuasplatoon-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'feihuasplatoon',
  storageBucket: 'feihuasplatoon.firebasestorage.app',
  messagingSenderId: '296266358174',
  appId: '1:296266358174:web:430e11c8075cd09b77ca8f',
}

const app = initializeApp(firebaseConfig)

export const auth = getAuth(app)
export const db = getDatabase(app)
