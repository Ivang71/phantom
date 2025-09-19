import requests
import re
import random
import time
import json
import signal
import sys
import threading
from urllib.parse import urljoin


def create_session():
    session = requests.Session()
    session.proxies = {
        'http': 'http://spnmwgk1qy:rzc=KO53v2Wp5vitSh@dc.decodo.com:10000',
        'https': 'http://spnmwgk1qy:rzc=KO53v2Wp5vitSh@dc.decodo.com:10000'
    }
    return session

def get_current_ip(session):
    try:
        response = session.get('https://ip.decodo.com/json', timeout=5)
        if response.status_code == 200:
            return json.loads(response.text)['proxy']['ip']
    except:
        pass
    return None

def get(session, url):
    try:
        return session.get(url, allow_redirects=False, timeout=5)
    except:
        return None

def measure_request(response):
    if not response:
        return 0, 0
    req_size = len(f"GET {response.url} HTTP/1.1") + len(str(response.request.headers)) + 100
    resp_size = len(response.content) + len(str(response.headers)) + 50
    return req_size, resp_size

running = True

def signal_handler(signum, frame):
    global running
    print("\nReceived interrupt signal. Shutting down gracefully...")
    running = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

cb = int(time.time() * 1000)
total_data_sent = 0
total_data_received = 0
successful_cycles = 0


while running:
    try:
        session = create_session()
        current_ip = None
        if successful_cycles < 2:
            current_ip = get_current_ip(session)
        total_sent = total_received = 0
        cb += random.randint(1000000000, 9999999999)
        url = f"https://p.pcdelv.com/go/495017/746000/aHR0cCUzQS8vZ2xvYmFsc3RyZWFtaW5nLmxvbC8?cb={cb}"
        
        r = get(session, url)
        if not r:
            continue
        req_size, resp_size = measure_request(r)
        total_sent += req_size
        total_received += resp_size
        
        redirects = re.findall(r'(?:top\.location\.href|window\.location)\s*=\s*"([^"]+)"', r.text or "")
        if not redirects:
            continue
        url = urljoin(url, redirects[0]) + f"?cb={cb}"
        
        r2 = get(session, url)
        if not r2:
            continue
        req_size2, resp_size2 = measure_request(r2)
        total_sent += req_size2
        total_received += resp_size2
        
        total_data_sent += total_sent
        total_data_received += total_received
        successful_cycles += 1
        
        if current_ip:
            print(f"Cycle {successful_cycles} [IP: {current_ip}]: Sent {total_sent}b Received {total_received}b | Total: {total_data_sent + total_data_received}b")
        else:
            print(f"Cycle {successful_cycles}: Sent {total_sent}b Received {total_received}b | Total: {total_data_sent + total_data_received}b")
    except KeyboardInterrupt:
        print("\nKeyboard interrupt received. Exiting...")
        break
    except Exception as e:
        print("Error ", e)

    if running:
        time.sleep(0.0)

print(f"Final stats: {successful_cycles} cycles, {total_data_sent + total_data_received}b total")
