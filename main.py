import os
import re
import time
import json
import signal
import random
import base64
import urllib.parse
import asyncio
from urllib.parse import urljoin
from rnet import Client, Impersonate, StatusCode
from dotenv import load_dotenv

load_dotenv()

async def create_client():
    proxy_user = os.getenv('PROXY_USER')
    proxy_pass = os.getenv('PROXY_PASS')
    proxy_host = os.getenv('PROXY_HOST')
    proxy_port = os.getenv('PROXY_PORT')
    
    proxy_url = None
    if proxy_user and proxy_pass and proxy_host and proxy_port:
        proxy_url = f"http://{proxy_user}:{proxy_pass}@{proxy_host}:{proxy_port}"
    
    client = Client(
        impersonate=Impersonate.Chrome137,
        proxy=proxy_url,
        headers={
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        }
    )
    return client

async def get_current_ip(client):
    try:
        response = await client.get('https://ip.decodo.com/json')
        if response.status_code == 200:
            data = await response.json()
            return data['proxy']['ip']
    except:
        pass
    return None

async def get(client, url):
    try:
        return await client.get(url, allow_redirects=False)
    except:
        return None

async def readiness_probe(client):
    try:
        probe_url = "http://dcba.popcash.net/znWaa3gu"
        print(f"Testing readiness probe: {probe_url}")
        response = await client.get(probe_url)
        success = response is not None
        print(f"Readiness probe result: {success}")
        return success
    except Exception as e:
        print(f"Readiness probe error: {e}")
        return False

def wrap_target_url(target_url):
    uid = "495017"
    wid = "746009"
    esc = urllib.parse.quote(
        target_url.encode('latin-1','backslashreplace').decode(),
        safe="~()*!.'"
    )
    b64 = base64.b64encode(esc.encode()).decode()
    cb = f"{int(time.time()*1000)}.{random.randint(0, 1000000)}"
    return f"http://p.pcdelv.com/go/{uid}/{wid}/{b64}?cb={cb}"


def format_bytes(bytes_value):
    if bytes_value >= 1024 * 1024 * 1024:
        return f"{bytes_value / (1024 * 1024 * 1024):.2f}GB"
    if bytes_value >= 1024 * 1024:
        return f"{bytes_value / (1024 * 1024):.2f}MB"
    elif bytes_value >= 1024:
        return f"{bytes_value / 1024:.2f}KB"
    else:
        return f"{bytes_value}B"

def measure_request(response):
    if not response:
        return 0, 0
    req_size = len(f"GET {response.url} HTTP/1.1") + 100
    resp_size = response.content_length or 1000  # Use content_length or estimate
    return req_size, resp_size

running = True

def signal_handler(signum, frame):
    global running
    print("\nReceived interrupt signal. Shutting down gracefully...")
    running = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

async def main():
    target_url = "https://globalstreaming.lol/"
    total_data_sent = 0
    total_data_received = 0
    successful_cycles = 0

    print("Starting bot...")
    while running:
        try:
            client = await create_client()
            current_ip = None
            if successful_cycles < 2:
                current_ip = await get_current_ip(client)
            
            if not await readiness_probe(client):
                print("Readiness probe failed, retrying...")
                continue
            
            total_sent = total_received = 0
            go_url = wrap_target_url(target_url)
            print(f"Attempting to fetch: {go_url}")
            
            r = await get(client, go_url)
            if not r:
                print("Failed to get initial response")
                continue
            print(f"Initial response status: {r.status_code}")
            req_size, resp_size = measure_request(r)
            total_sent += req_size
            total_received += resp_size
            
            https_response = r
            
            status = int(str(r.status_code))
            
            if status in (301, 302, 303, 307, 308) and "Location" in r.headers:
                go_url_https = r.headers["Location"]
                https_response = await get(client, go_url_https)
                if not https_response or int(str(https_response.status_code)) != 200:
                    continue
                
                req_size_https, resp_size_https = measure_request(https_response)
                total_sent += req_size_https
                total_received += resp_size_https
            elif status == 200:
                go_url_https = go_url
            else:
                continue
            
            text_content = await https_response.text()
            v2_match = re.search(r'top\.location\.href\s*=\s*["\']([^"\']+)["\']', text_content or "")
            if not v2_match:
                v2_match = re.search(r'href\s*=\s*["\']([^"\']*v2[^"\']*)["\']', text_content or "")
            if not v2_match:
                continue
            
            v2_path = v2_match.group(1)
            cl_url = f"https://p.pcdelv.com{v2_path}"
            client.headers["Referer"] = go_url_https
            v2_response = await get(client, cl_url)
            if not v2_response:
                continue
            req_size2, resp_size2 = measure_request(v2_response)
            total_sent += req_size2
            total_received += resp_size2
            
            if int(str(v2_response.status_code)) == 302 and "Location" in v2_response.headers:
                final_url = v2_response.headers["Location"]
                final_response = await get(client, final_url)
                if final_response:
                    req_size3, resp_size3 = measure_request(final_response)
                    total_sent += req_size3
                    total_received += resp_size3
            
            total_data_sent += total_sent
            total_data_received += total_received
            successful_cycles += 1
            
            if current_ip:
                print(f"Cycle {successful_cycles} [IP: {current_ip}]: Sent {format_bytes(total_sent)} Received {format_bytes(total_received)} | Total: {format_bytes(total_data_sent + total_data_received)}")
            else:
                print(f"Cycle {successful_cycles}: Sent {format_bytes(total_sent)} Received {format_bytes(total_received)} | Total: {format_bytes(total_data_sent + total_data_received)}")
        except KeyboardInterrupt:
            print("\nKeyboard interrupt received. Exiting...")
            break
        except Exception as e:
            print("Error ", e)

        if running:
            await asyncio.sleep(random.uniform(2, 4))

    print(f"Final stats: {successful_cycles} cycles, {format_bytes(total_data_sent + total_data_received)} total")

if __name__ == "__main__":
    asyncio.run(main())