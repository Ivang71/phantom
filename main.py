import requests
import re
import random
import time
import json
import signal
import sys
import threading
import os
import base64
import urllib.parse
from urllib.parse import urljoin
from dotenv import load_dotenv

load_dotenv()


def create_session():
    session = requests.Session()
    proxy_user = os.getenv('PROXY_USER')
    proxy_pass = os.getenv('PROXY_PASS')
    proxy_host = os.getenv('PROXY_HOST')
    proxy_port = os.getenv('PROXY_PORT')
    
    if proxy_user and proxy_pass and proxy_host and proxy_port:
        proxy_url = f"http://{proxy_user}:{proxy_pass}@{proxy_host}:{proxy_port}"
        session.proxies = {
            'http': proxy_url,
            'https': proxy_url
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

def wrap_target_url(target_url):
    uid = "495017"
    wid = "746000"
    esc = urllib.parse.quote(target_url, safe="~()*!.'")
    b64 = base64.b64encode(esc.encode()).decode()
    cb = f"{int(time.time()*1000)}.{random.randint(0, 1000000)}"
    return f"https://p.pcdelv.com/go/{uid}/{wid}/{b64}?cb={cb}"

def measure_request(response):
    if not response:
        return 0, 0
    req_size = len(f"GET {response.url} HTTP/1.1") + len(str(response.request.headers)) + 100
    resp_size = len(response.content) + len(str(response.headers)) + 50
    return req_size, resp_size

running = True
stats_lock = threading.Lock()

def signal_handler(signum, frame):
    global running
    print("\nReceived interrupt signal. Shutting down gracefully...")
    running = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

total_data_sent = 0
total_data_received = 0
successful_cycles = 0


def worker(thread_id):
    global total_data_sent, total_data_received, successful_cycles
    target_url = "https://globalstreaming.lol/"
    
    while running:
        try:
            session = create_session()
            current_ip = None
            with stats_lock:
                if successful_cycles < 2:
                    current_ip = get_current_ip(session)
            
            total_sent = total_received = 0
            go_url = wrap_target_url(target_url)
            
            r = get(session, go_url)
            if not r:
                continue
            req_size, resp_size = measure_request(r)
            total_sent += req_size
            total_received += resp_size
            
            v2_match = re.search(r'href="([^"]+)"', r.text or "")
            if not v2_match:
                continue
                
            v2_url = urljoin(go_url, v2_match.group(1))
            session.headers["Referer"] = go_url
            
            v2_response = get(session, v2_url)
            if not v2_response:
                continue
            req_size2, resp_size2 = measure_request(v2_response)
            total_sent += req_size2
            total_received += resp_size2
            
            if v2_response.status_code == 302 and "Location" in v2_response.headers:
                final_url = v2_response.headers["Location"]
                final_response = get(session, final_url)
                if final_response:
                    req_size3, resp_size3 = measure_request(final_response)
                    total_sent += req_size3
                    total_received += resp_size3
            
            with stats_lock:
                total_data_sent += total_sent
                total_data_received += total_received
                successful_cycles += 1
                current_total = total_data_sent + total_data_received
                current_cycles = successful_cycles
            
            if current_ip:
                print(f"Thread {thread_id} Cycle {current_cycles} [IP: {current_ip}]: Sent {total_sent}b Received {total_received}b | Total: {current_total}b")
            else:
                print(f"Thread {thread_id} Cycle {current_cycles}: Sent {total_sent}b Received {total_received}b | Total: {current_total}b")
        except KeyboardInterrupt:
            print(f"\nThread {thread_id} keyboard interrupt received. Exiting...")
            break
        except Exception as e:
            print(f"Thread {thread_id} Error: {e}")

        if running:
            time.sleep(0.0)

threads = []
for i in range(2):
    thread = threading.Thread(target=worker, args=(i+1,))
    threads.append(thread)
    thread.start()

try:
    for thread in threads:
        thread.join()
except KeyboardInterrupt:
    print("\nMain thread keyboard interrupt received. Exiting...")
    running = False
    for thread in threads:
        thread.join()

print(f"Final stats: {successful_cycles} cycles, {total_data_sent + total_data_received}b total")
